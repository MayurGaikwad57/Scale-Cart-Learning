import type { Request, RequestHandler } from "express";
import { kv } from "../config/kv.js";
import { HttpError } from "../utils/errors.js";

/**
 * Distributed rate limiting with the SLIDING WINDOW COUNTER algorithm, stored in ScaleKV so
 * that all API instances share the same counters (a per-process counter would let a client
 * get N x the limit by being load-balanced across N instances).
 *
 * The three algorithms you should be able to compare:
 *  - FIXED WINDOW: one counter per minute (12:00:00-12:00:59). Cheap, but a client can send
 *    `limit` requests at 12:00:59 and `limit` more at 12:01:00 -> 2x the limit in 2 seconds.
 *  - SLIDING WINDOW LOG: store a timestamp per request, count those in the last 60s. Exact,
 *    but memory grows with the limit (100 timestamps per user).
 *  - TOKEN BUCKET: a bucket refills at `rate` tokens/s up to `capacity`; each request takes one.
 *    Allows controlled bursts. Needs read-modify-write of 2 fields -> atomic script in Redis.
 *  - SLIDING WINDOW COUNTER (used here): keep the fixed-window counters for the CURRENT and
 *    PREVIOUS window and weight the previous one by how much of it still overlaps the sliding
 *    window:
 *          estimate = previous * (1 - elapsedFractionOfCurrentWindow) + current
 *    Two small counters per client, no boundary burst, and only INCR/GET are needed.
 *
 * FAIL OPEN: if ScaleKV is down we let requests through. The alternative (fail closed =
 * reject everything) would turn a cache outage into a full site outage. For a login
 * brute-force limiter at a bank you might choose differently - it's a trade-off.
 */

export interface RateLimitRule {
  name: string; // part of the key, so different rules never share counters
  limit: number; // max requests ...
  windowMs: number; // ... per window
  /** Who is being limited. Default: the logged-in user, else the client IP. */
  keyBy?: (req: Request) => string;
}

const defaultKey = (req: Request) => (req.user ? `user:${req.user.id}` : `ip:${req.ip}`);

export function rateLimit(rule: RateLimitRule): RequestHandler {
  const keyBy = rule.keyBy ?? defaultKey;

  return async (req, res, next) => {
    if (!kv.isReady) return next(); // fail open

    const now = Date.now();
    const window = Math.floor(now / rule.windowMs);
    const elapsed = (now % rule.windowMs) / rule.windowMs; // 0.0 .. 1.0 into the current window
    const base = `rl:${rule.name}:${keyBy(req)}`;
    const currentKey = `${base}:${window}`;

    let current: number;
    let previous: number;
    try {
      // Three commands, ONE network round trip (pipelining: we don't await each one).
      //  1. create the counter WITH its expiry if missing (NX). Doing SET-with-TTL first means
      //     there's no moment where the counter exists without a TTL (no leaked keys).
      //  2. INCR it (keeps the TTL). Atomic: two API instances can't both read 4 and write 5.
      //  3. read the previous window's counter.
      const [, cur, prev] = await Promise.all([
        kv.set(currentKey, "0", { pxMs: rule.windowMs * 2, nx: true }),
        kv.incr(currentKey),
        kv.get(`${base}:${window - 1}`),
      ]);
      current = cur;
      previous = Number(prev ?? 0);
    } catch {
      return next(); // fail open
    }

    const estimate = previous * (1 - elapsed) + current;
    const resetSeconds = Math.ceil(((1 - elapsed) * rule.windowMs) / 1000);
    // Standard-ish headers (IETF RateLimit draft) so clients can slow down before hitting 429.
    res.set({
      "RateLimit-Limit": String(rule.limit),
      "RateLimit-Remaining": String(Math.max(0, Math.floor(rule.limit - estimate))),
      "RateLimit-Reset": String(resetSeconds),
    });

    if (estimate > rule.limit) {
      res.set("Retry-After", String(resetSeconds));
      return next(
        new HttpError(429, "too_many_requests", `Too many requests. Please try again in ${resetSeconds} seconds.`),
      );
    }
    next();
  };
}

const byIp = (req: Request) => `ip:${req.ip}`;

// The rules ScaleCart uses - the ONE place to tune them (the admin System page reads these too).
export const rules = {
  // Every API call, per IP: stops one client from flooding the whole API.
  global: { name: "global", limit: 300, windowMs: 60_000, keyBy: byIp, per: "IP address", appliesTo: "every API request" },
  // Login/register, per IP: makes password guessing slow. (Try 11 wrong logins in the UI.)
  auth: { name: "auth", limit: 10, windowMs: 60_000, keyBy: byIp, per: "IP address", appliesTo: "login & register" },
  // Checkout, per user: placing orders is expensive (DB locks, payment calls).
  orders: { name: "orders", limit: 10, windowMs: 60_000, per: "user", appliesTo: "placing orders" },
} satisfies Record<string, RateLimitRule & { per: string; appliesTo: string }>;

export const limits = {
  global: rateLimit(rules.global),
  auth: rateLimit(rules.auth),
  orders: rateLimit(rules.orders),
};
