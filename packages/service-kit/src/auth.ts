import { createPublicKey, type KeyObject } from "node:crypto";
import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { forbidden, HttpError, unauthorized } from "./errors.js";
import { serviceUrls } from "./registry.js";

/**
 * TOKEN VERIFICATION with the identity service's PUBLIC key (M6.5 phase 4: RS256 + JWKS).
 *
 *   identity service   holds the PRIVATE key -> the only one that can SIGN (create) a token
 *   every other one    downloads the PUBLIC key from  identity /.well-known/jwks.json  -> can only VERIFY
 *
 * Before (HS256), every service had the same secret - so every service could also FORGE a token for
 * any user, including an admin. Now a compromised order service still can't mint tokens.
 *
 * The keys are CACHED in memory: verifying a token is a local CPU operation, no call to the identity
 * service per request - if it is down, everyone already logged in keeps working. An unknown key id
 * ("kid") triggers ONE refetch (that is how key ROTATION works: identity starts signing with a new key,
 * services learn it on the first token they see), at most every few seconds so garbage tokens can't
 * make us hammer the identity service.
 */
export type Role = "CUSTOMER" | "ADMIN";
export interface AuthUser {
  id: string;
  role: Role;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

const keys = new Map<string, KeyObject>();
let lastFetch = 0;
let inflight: Promise<void> | undefined;
const REFETCH_MIN_INTERVAL_MS = 5_000;

/** Where the public keys are published. Read at call time: tests move services to random ports. */
export const jwksUrl = () => `${serviceUrls.identity}/.well-known/jwks.json`;

async function fetchKeys() {
  lastFetch = Date.now();
  const res = await fetch(jwksUrl(), { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`JWKS answered ${res.status}`);
  const body = (await res.json()) as { keys: ({ kid?: string } & Record<string, unknown>)[] };
  // REPLACE the set, don't merge into it: a key the identity service no longer publishes (retired
  // or compromised) must stop being trusted on the next fetch, not live on until a restart.
  const fresh = new Map<string, KeyObject>();
  for (const jwk of body.keys) if (jwk.kid) fresh.set(jwk.kid, createPublicKey({ key: jwk as Parameters<typeof createPublicKey>[0] & object, format: "jwk" } as never));
  keys.clear();
  for (const [kid, key] of fresh) keys.set(kid, key);
  for (const [kid, key] of localKeys) keys.set(kid, key);
}

/**
 * For the identity service itself: it HAS its key pair, so it trusts its own public key directly
 * instead of downloading its own JWKS over HTTP.
 */
const localKeys = new Map<string, KeyObject>();
export function trustLocalKey(kid: string, publicKey: KeyObject) {
  localKeys.set(kid, publicKey);
  keys.set(kid, publicKey);
}

async function keyFor(kid: string): Promise<KeyObject | undefined> {
  if (keys.has(kid)) return keys.get(kid);
  // A fetch is already running (e.g. the first tokens after a key rotation): wait for it instead of
  // answering 401 - it is probably bringing exactly this key (code review).
  if (inflight) await inflight.catch(() => undefined);
  if (keys.has(kid)) return keys.get(kid);
  if (Date.now() - lastFetch < REFETCH_MIN_INTERVAL_MS && keys.size) return undefined; // just tried
  inflight ??= fetchKeys().finally(() => (inflight = undefined)); // one fetch, however many requests wait
  try {
    await inflight;
  } catch (e) {
    // Never fetched anything and identity unreachable: we CANNOT check tokens -> 503, not 401
    // (the token may be perfectly fine; telling the user "log in again" would be wrong).
    if (!keys.size) throw new HttpError(503, "auth_unavailable", `Can't verify sign-ins right now: ${(e as Error).message}`);
  }
  return keys.get(kid);
}

/** Verify a token: signature (RS256 ONLY), expiry. Returns the user or throws 401. */
export async function verifyToken(token: string): Promise<AuthUser> {
  const decoded = jwt.decode(token, { complete: true });
  const kid = decoded?.header.kid;
  if (!kid) throw unauthorized("invalid_token");
  const key = await keyFor(kid);
  if (!key) throw unauthorized("invalid_token");
  try {
    // algorithms: ["RS256"] - NEVER trust the "alg" in the token header. Otherwise an attacker could
    // send an HS256 token "signed" with our PUBLIC key as the secret (the classic algorithm-confusion attack).
    const payload = jwt.verify(token, key, { algorithms: ["RS256"] }) as jwt.JwtPayload;
    return { id: payload.sub as string, role: payload.role as Role };
  } catch {
    throw unauthorized("invalid_token");
  }
}

// Reads "Authorization: Bearer <token>", verifies it, and attaches req.user.
export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw unauthorized("missing_token");
  req.user = await verifyToken(header.slice(7));
  next();
};

// For public routes that behave differently for logged-in users (e.g. admins see inactive
// products). A missing or bad token is not an error here: the caller is just anonymous.
export const optionalAuth: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      req.user = await verifyToken(header.slice(7));
    } catch {
      /* treat as anonymous */
    }
  }
  next();
};

// Use after authenticate: requireRole("ADMIN")
export const requireRole =
  (role: Role): RequestHandler =>
  (req, _res, next) => {
    if (req.user?.role !== role) throw forbidden("insufficient_role");
    next();
  };
