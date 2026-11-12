import cors from "cors";
import express from "express";
import helmet from "helmet";
import { errorHandler } from "@scalecart/service-kit/error-handler";
import { byIp, rateLimit } from "@scalecart/service-kit/rate-limit";
import { requestContext } from "@scalecart/service-kit/request-context";
import { adminServicesRouter, healthRouter } from "./aggregation.routes.js";
import { env } from "./config/env.js";
import { proxyTo } from "./proxy.js";
import { edgeAuth, ROUTES } from "./routes-table.js";

/**
 * API GATEWAY (:3000) - the single front door. The Angular app talks to ONE address and has no idea
 * that there are six services behind it.
 *
 * Its jobs (and ONLY these - no business logic here, or the gateway becomes a new monolith):
 *   ROUTING           path prefix -> service                         (routes-table.ts)
 *   AUTHENTICATION    reject a missing/invalid token at the edge     (routes-table.ts)
 *   RATE LIMITING     the global per-IP limit (one shared counter in ScaleKV)
 *   CORRELATION       X-Request-Id on every request and response
 *   CORS              the browser-facing policy lives in one place
 *   PROTECTION        /internal/* is never forwarded; slow/dead services become 504/502 quickly (proxy.ts)
 *   AGGREGATION       /health/ready and /admin/services combine every service in one call (aggregation.routes.ts)
 *
 * This file only ASSEMBLES the gateway - and here the ORDER of the lines is the design: health checks
 * before the rate limit (a load balancer's probes must never be throttled), /internal blocked before
 * anything is forwarded, then the proxies, then 404 and the error handler.
 * Services STILL verify the token themselves ("zero trust"): if someone reaches a service directly,
 * bypassing the gateway, it must not be an open door.
 */
export { ROUTES } from "./routes-table.js";

export function createGatewayApp() {
  const app = express();
  // The gateway faces the browser directly, so by default it trusts NO forwarded headers (a client
  // could otherwise fake its IP to dodge rate limits). Behind a load balancer, set TRUST_PROXY.
  if (env.TRUST_PROXY) app.set("trust proxy", /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(",").map((o) => o.trim()),
      // Browsers hide response headers from JavaScript unless the server lists them here.
      exposedHeaders: ["X-Cache", "Retry-After", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Idempotent-Replayed", "X-Request-Id"],
    }),
  );
  app.use(requestContext);

  app.use(healthRouter);

  // Internal service-to-service routes are never reachable from outside.
  app.use("/internal", (_req, res) => res.status(404).json({ error: "not_found" }));

  // THE GATEWAY's policy: every API call, per IP - stops one client from flooding the whole API.
  app.use(rateLimit({ name: "gateway.global", limit: 300, windowMs: 60_000, keyBy: byIp, appliesTo: "every API request" }));

  app.use(adminServicesRouter);

  for (const r of ROUTES) app.use(r.prefix, ...edgeAuth[r.access], proxyTo(r.service, { timeoutMs: r.timeoutMs }));

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use(errorHandler);
  return app;
}
