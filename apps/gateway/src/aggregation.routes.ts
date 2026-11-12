import { Router } from "express";
import { GROUPS, groupsOfService } from "@scalecart/events";
import { kv } from "@scalecart/service-kit/kv";
import { enforcedRules } from "@scalecart/service-kit/rate-limit";
import { SERVICE_NAMES, serviceUrls, type ServiceName } from "@scalecart/service-kit/registry";
import { proxyStats } from "./proxy.js";
import { edgeAuth, ROUTES } from "./routes-table.js";

/**
 * AGGREGATION - the gateway is the one component that sees every service, so it answers questions
 * about the WHOLE system in one call:
 *   GET /health          the gateway itself is alive (liveness)
 *   GET /health/ready    can the shop be used? (it asks every service's /health/ready)
 *   GET /admin/services  every service: health, routes, consumer groups, rate limits, traffic
 */
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

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => res.json({ status: "ok", service: "gateway" }));

// Aggregated readiness: the site is usable if the order service is (it serves almost every page).
healthRouter.get("/health/ready", async (_req, res) => {
  const services = await Promise.all(SERVICE_NAMES.map(probe));
  const order = services.find((s) => s.service === "order")!;
  res.status(order.up ? 200 : 503).json({
    status: order.up ? (services.every((s) => s.up) ? "ready" : "degraded") : "unavailable",
    services: Object.fromEntries(services.map((s) => [s.service, s.up ? "up" : "down"])),
  });
});

export const adminServicesRouter = Router();

// Admin > Services.
adminServicesRouter.get("/admin/services", ...edgeAuth.admin, async (_req, res) => {
  const services = await Promise.all(SERVICE_NAMES.map(probe));
  res.json({
    gateway: { pid: process.pid, uptimeSeconds: Math.round(process.uptime()), kv: kv.status, rateLimits: enforcedRules() },
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
