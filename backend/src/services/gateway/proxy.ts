import http from "node:http";
import type { Request, RequestHandler } from "express";
import { serviceUrls, type ServiceName } from "../registry.js";

/**
 * A REVERSE PROXY in ~80 lines - what nginx / Envoy / Kong / AWS API Gateway do at their core.
 *
 *   browser ── request ──► gateway ── same request ──► service
 *   browser ◄── response ── gateway ◄── response ───── service
 *
 * The body is STREAMED (req.pipe(upstream), upstream.pipe(res)): the gateway never parses or buffers
 * it, so a 10 MB upload doesn't cost the gateway 10 MB of memory and adds almost no latency.
 *
 * What the proxy adds on the way:
 *   X-Forwarded-For / -Proto / -Host  the ORIGINAL client's address (the service sees the gateway's)
 *   X-Request-Id                      correlation id (set by requestContext before we get here)
 * and what it protects against:
 *   a service that is down            -> 502 { error: "service_unavailable" }  (not a hang)
 *   a service that is too slow        -> 504 { error: "service_timeout" }      (timeout per route)
 */

// "Hop-by-hop" headers describe ONE connection (browser<->gateway), not the request; RFC 9110
// says a proxy must not forward them.
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade"]);

export interface ServiceStats {
  requests: number;
  errors: number; // 5xx from the service + proxy failures
  unavailable: number; // 502/504 produced by the gateway itself
  inFlight: number;
  totalMs: number;
  lastError: string | null;
}
export const proxyStats = {} as Record<ServiceName, ServiceStats>;
const statsOf = (s: ServiceName) =>
  (proxyStats[s] ??= { requests: 0, errors: 0, unavailable: 0, inFlight: 0, totalMs: 0, lastError: null });

// One pool of keep-alive connections per gateway: reusing TCP connections to the services saves a
// handshake on every request.
const agent = new http.Agent({ keepAlive: true, maxSockets: 100 });

function forwardedFor(req: Request) {
  const prior = req.headers["x-forwarded-for"];
  const client = req.socket.remoteAddress ?? "";
  return prior ? `${prior}, ${client}` : client;
}

export function proxyTo(service: ServiceName, opts: { timeoutMs?: number } = {}): RequestHandler {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return (req, res) => {
    const target = new URL(serviceUrls[service]);
    const stats = statsOf(service);
    const started = Date.now();
    stats.requests++;
    stats.inFlight++;
    let finished = false;
    const done = (error?: string) => {
      if (finished) return;
      finished = true;
      stats.inFlight--;
      stats.totalMs += Date.now() - started;
      if (error) {
        stats.errors++;
        stats.lastError = `${new Date().toISOString()} ${error}`;
      }
    };

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
    headers.host = target.host;
    headers["x-forwarded-for"] = forwardedFor(req);
    headers["x-forwarded-proto"] = req.protocol;
    headers["x-forwarded-host"] = req.headers.host ?? "";
    headers["x-request-id"] = res.getHeader("X-Request-Id") as string;

    const upstream = http.request(
      { hostname: target.hostname, port: target.port, method: req.method, path: req.originalUrl, headers, agent, timeout: timeoutMs },
      (up) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) out[k] = v;
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
        up.on("end", () => done((up.statusCode ?? 500) >= 500 ? `${service} answered ${up.statusCode}` : undefined));
        up.on("error", () => done(`${service} response aborted`));
      },
    );

    // `timeout` = no bytes for timeoutMs. Destroying the request triggers "error" below.
    upstream.on("timeout", () => upstream.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    upstream.on("error", (err: NodeJS.ErrnoException) => {
      const timedOut = err.code === "ETIMEDOUT";
      done(`${service}: ${err.code ?? err.message}`);
      if (res.headersSent) return void res.destroy(); // mid-response: all we can do is cut it
      stats.unavailable++;
      res.status(timedOut ? 504 : 502).json(
        timedOut
          ? { error: "service_timeout", service, message: `The ${service} service did not answer in time. Please try again.` }
          : { error: "service_unavailable", service, message: `The ${service} service is not available right now. Please try again in a moment.` },
      );
    });
    // Browser gave up (closed the tab): stop the upstream work too.
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });

    req.pipe(upstream);
  };
}
