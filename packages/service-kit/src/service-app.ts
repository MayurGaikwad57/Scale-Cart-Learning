import type { Server } from "node:http";
import express, { type Express } from "express";
import helmet from "helmet";
import { broker } from "./broker.js";
import { runningConsumers, startConsumers, stopConsumers, type ConsumerDef } from "./consumers.js";
import { kitEnv as env } from "./env.js";
import { errorHandler } from "./error-handler.js";
import { kv } from "./kv.js";
import type { ServiceName } from "./registry.js";
import { requestContext } from "./request-context.js";

/**
 * The skeleton every ScaleCart service shares (a "service template" / MICROSERVICE CHASSIS). Each
 * service only adds its own routes; health checks, request ids, JSON errors and graceful shutdown
 * are identical, so operating many services feels like operating one.
 *
 * The chassis knows nothing about any service's database or events: the service PASSES IN its
 * database (for the readiness check and shutdown) and its consumer groups.
 */
export interface ServiceDb {
  /** Throws if the database can't be reached (e.g. SELECT 1). */
  ping: () => Promise<unknown>;
  disconnect: () => Promise<void>;
}

/** The ServiceDb of a Prisma client (any service's generated client has these two methods). */
export const prismaDb = (client: { $queryRawUnsafe(sql: string): Promise<unknown>; $disconnect(): Promise<void> }): ServiceDb => ({
  ping: () => client.$queryRawUnsafe("SELECT 1"),
  disconnect: () => client.$disconnect(),
});

export function createServiceApp(name: ServiceName, mount: (app: Express) => void, opts: { db?: ServiceDb } = {}): Express {
  const app = express();
  // Requests arrive THROUGH THE GATEWAY, so the TCP peer is the gateway, not the customer. Trusting
  // X-Forwarded-For from loopback lets req.ip be the customer's real address again - the per-IP
  // login rate limit depends on it. (Behind a real load balancer: set TRUST_PROXY to its hops/subnet.)
  const trust = env.TRUST_PROXY ?? "loopback";
  app.set("trust proxy", /^\d+$/.test(trust) ? Number(trust) : trust);
  app.use(helmet());
  app.use(requestContext);
  app.use(express.json());

  // Liveness: the process is up. Readiness: it can do its job (its database reachable). The
  // gateway's admin page polls /health/ready of every service.
  app.get("/health", (_req, res) => res.json({ status: "ok", service: name }));
  app.get("/health/ready", async (_req, res) => {
    const consumers = runningConsumers.map((c) => ({
      group: c.group,
      topic: c.topic,
      memberId: c.memberId,
      generation: c.generation,
      partitions: c.partitions,
      ...c.metrics,
    }));
    try {
      await opts.db?.ping();
      res.json({ status: "ready", service: name, pid: process.pid, uptimeSeconds: Math.round(process.uptime()), kv: kv.status, log: broker.conn.status, consumers });
    } catch {
      res.status(503).json({ status: "db_unavailable", service: name, pid: process.pid });
    }
  });

  mount(app);

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use(errorHandler); // must be last
  return app;
}

/**
 * Start a service process: connect to ScaleKV and ScaleLog (both optional), start the consumer
 * groups this service owns, listen, and shut down gracefully on Ctrl+C / SIGTERM.
 */
export function runService(opts: {
  name: ServiceName;
  port: number;
  app: Express;
  db?: ServiceDb;
  consumers?: readonly ConsumerDef[];
  onStart?: () => void;
  onStop?: () => void | Promise<void>;
}): Server {
  const tag = `[${opts.name}]`;
  if (env.KV_URL) kv.connect(env.KV_URL);
  else console.log(`${tag} KV_URL not set - running without ScaleKV`);
  if (env.LOG_URL) {
    broker.conn.connect(env.LOG_URL);
    if (opts.consumers?.length && env.RUN_WORKERS === "true") {
      startConsumers(opts.consumers);
      console.log(`${tag} consumer groups: ${opts.consumers.map((c) => `${c.group} (${c.topic})`).join(", ")}`);
    }
  } else {
    console.log(`${tag} LOG_URL not set - running without events`);
  }

  const server = opts.app.listen(opts.port, () => {
    console.log(`${tag} ${opts.name} service listening on :${opts.port} (pid ${process.pid})`);
    opts.onStart?.();
  });

  // Graceful shutdown: stop accepting requests, stop our own jobs, let consumers LEAVE their
  // groups (instant rebalance instead of a 10s heartbeat timeout), close the database.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await opts.onStop?.();
    await stopConsumers();
    await opts.db?.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}
