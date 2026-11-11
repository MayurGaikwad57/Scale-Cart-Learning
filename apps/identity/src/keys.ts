import { createPrivateKey, createPublicKey } from "node:crypto";
import { trustLocalKey } from "@scalecart/service-kit/auth";
import jwt from "jsonwebtoken";
import { env } from "./config/env.js";

/**
 * THE SIGNING KEY - the most sensitive secret in the system, and only THIS service has it.
 *
 * RS256 = RSA signature: a PRIVATE key signs, the matching PUBLIC key verifies. We publish the public
 * key as a JWKS ("JSON Web Key Set") at /.well-known/jwks.json - the same standard Google, Auth0,
 * Keycloak and Cognito use. Every other service downloads it and can VERIFY tokens, but never CREATE one.
 *
 * "kid" (key id) is written into every token's header, so a verifier knows which key to use. KEY
 * ROTATION: generate a new key with a new kid, publish BOTH public keys, sign with the new one; once
 * the old tokens have expired (1 h), stop publishing the old key.
 * In production the private key lives in a secrets manager / KMS (AWS KMS, Vault), never in a file.
 */
const privateKey = createPrivateKey(Buffer.from(env.JWT_PRIVATE_KEY, "base64").toString("utf8"));
const publicKey = createPublicKey(privateKey);
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: env.JWT_KEY_ID, alg: "RS256", use: "sig" };
// /auth/me verifies tokens in THIS process: trust our own key directly (no HTTP call to ourselves).
trustLocalKey(env.JWT_KEY_ID, publicKey);

export const TOKEN_TTL = "1h";

export function signToken(user: { id: string; role: string }, expiresIn: string | number = TOKEN_TTL) {
  return jwt.sign({ role: user.role }, privateKey, { algorithm: "RS256", keyid: env.JWT_KEY_ID, subject: user.id, expiresIn: expiresIn as never });
}

/** The public half - safe to give to anyone. */
export const jwks = () => ({ keys: [publicJwk] });
