import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { env } from "../../config/env.js";
import { HttpError } from "../../utils/errors.js";

/**
 * SERVICE-TO-SERVICE AUTHENTICATION for /internal/* routes (e.g. the order service asking the
 * inventory service to reserve stock). Two layers:
 *   1. the gateway refuses to forward any /internal path -> unreachable from the internet;
 *   2. this shared secret -> another process on the network can't call it either.
 * Real systems use mTLS (each service has a certificate) or signed service tokens instead of one
 * shared secret, but the idea is the same: "who is calling me?" for machines, not just users.
 */
export const INTERNAL_TOKEN_HEADER = "x-internal-token";

const expected = () => Buffer.from(env.INTERNAL_TOKEN);

export const requireInternal: RequestHandler = (req, _res, next) => {
  const got = Buffer.from(req.header(INTERNAL_TOKEN_HEADER) ?? "");
  // timingSafeEqual: comparison time doesn't reveal how many leading characters were right.
  if (got.length !== expected().length || !timingSafeEqual(got, expected())) {
    throw new HttpError(403, "internal_only", "This endpoint is only for other ScaleCart services.");
  }
  next();
};
