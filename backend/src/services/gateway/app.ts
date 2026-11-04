import cors from "cors";
import express, { type RequestHandler } from "express";
import helmet from "helmet";
import { env } from "../../config/env.js";
import { kv } from "../../config/kv.js";
import { GROUPS, groupsOfService } from "../../events/workers.js";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { errorHandler } from "../../middleware/errorHandler.js";
import { limits } from "../../middleware/rateLimit.js";
import { SERVICE_NAMES, serviceUrls, type ServiceName } from "../registry.js";
import { requestContext } from "../shared/request-context.js";
import { proxyStats, proxyTo } from "./proxy.js";

/**
 * API GATEWAY (:3000) - the single front door. The Angular app still talks to ONE address and has
 * no idea that there are now four services behind it.
 *
 * Its jobs (and ONLY these - no business logic here, or the gateway becomes a new monolith):
 *   ROUTING           path prefix -> service (the table below)
 *   AUTHENTICATION    reject a missing/invalid token at the edge, before it costs a service anything
 *   RATE LIMITING     the global per-IP limit (one shared counter in ScaleKV)
 *   CORRELATION       X-Request-Id on every request and response
 *   CORS              the browser-facing policy lives in one place
 *   PROTECTION        /internal/* is never forwarded; slow/dead services become 504/502 quickly
 *   AGGREGATION       /health/ready and /admin/services combine every service's health in one call
 *
 * Services STILL verify the token themselves ("zero trust" / defence in depth): if someone reaches
 * a service directly, bypassing the gateway, it must not be an open door.
 */
type Access = "public" | "user" | "admin";

export const ROUTES: { prefix: string; service: ServiceName; access: Access; timeoutMs?: number }[] = [
  { prefix: "/notifications", service: "notification", access: "user" },
  { prefix: "/inventory", service: "inventory", access: "public" }, // POST is admin-only, checked by the service
  { prefix: "/admin/payments", service: "payment", access: "admin" },
  { prefix: "/admin", service: "order", access: "admin" },
  { prefix: "/orders", service: "order", access: "user", timeoutMs: 20_000 }, // checkout calls inventory too
  { prefix: "/cart", service: "order", access: "user" },
  { prefix: "/products", service: "order", access: "public" },
  { prefix: "/auth", service: "order", access: "public" }, // /auth/me checks the token itself
];

const edgeAuth: Record<Access, RequestHandler[]> = {
  public: [],
  user: [authenticate],
  admin: [authenticate, requireRole("ADMIN")],
};

async function probe(service: ServiceName) {
  const started = Date.now();
  try {
    const res = await fetch(`${serviceUrls[service]}/health/ready`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as Record<string, unknown>;
    return { service, url: serviceUrls[service], up: res.ok, latencyMs: Date.now() - started, ...body };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    return { service, url: serviceUrls[service], up: false, latencyMs: Date.now() - started, status: err.name === "TimeoutError" ? "timeout" : (err.cause?.code ?? "down") };
  }
}

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

  app.get("/health", (_req, res) => res.json({ status: "ok", service: "gateway" }));
  // Aggregated readiness: the site is usable if the order service is (it serves almost every page).
  app.get("/health/ready", async (_req, res) => {
    const services = await Promise.all(SERVICE_NAMES.map(probe));
    const order = services.find((s) => s.service === "order")!;
    res.status(order.up ? 200 : 503).json({
      status: order.up ? (services.every((s) => s.up) ? "ready" : "degraded") : "unavailable",
      services: Object.fromEntries(services.map((s) => [s.service, s.up ? "up" : "down"])),
    });
  });

  // Internal service-to-service routes are never reachable from outside.
  app.use("/internal", (_req, res) => res.status(404).json({ error: "not_found" }));

  app.use(limits.global);

  // Admin > Services: the gateway's own endpoint (it is the one component that sees every service).
  app.get("/admin/services", ...edgeAuth.admin, async (_req, res) => {
    const services = await Promise.all(SERVICE_NAMES.map(probe));
    res.json({
      gateway: { pid: process.pid, uptimeSeconds: Math.round(process.uptime()), kv: kv.status },
      services: services.map((s) => {
        const st = proxyStats[s.service];
        return {
          ...s,
          routes: ROUTES.filter((r) => r.service === s.service).map((r) => r.prefix),
          groups: groupsOfService(s.service).map((g) => ({ group: g, topic: GROUPS[g].topic, description: GROUPS[g].description })),
          traffic: st
            ? { requests: st.requests, errors: st.errors, unavailable: st.unavailable, inFlight: st.inFlight, avgMs: st.requests ? Math.round(st.totalMs / st.requests) : 0, lastError: st.lastError }
            : { requests: 0, errors: 0, unavailable: 0, inFlight: 0, avgMs: 0, lastError: null },
        };
      }),
    });
  });

  for (const r of ROUTES) app.use(r.prefix, ...edgeAuth[r.access], proxyTo(r.service, { timeoutMs: r.timeoutMs }));

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use(errorHandler);
  return app;
}
