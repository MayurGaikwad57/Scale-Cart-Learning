import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { kv } from "./config/kv.js";
import { prisma } from "./config/prisma.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { limits } from "./middleware/rateLimit.js";
import { apiRouter } from "./routes/index.js";

export function createApp() {
  const app = express();
  if (env.TRUST_PROXY) app.set("trust proxy", /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(",").map((o) => o.trim()),
      // Browsers hide response headers from JavaScript unless the server lists them here.
      exposedHeaders: ["X-Cache", "Retry-After", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Idempotent-Replayed"],
    }),
  );
  app.use(express.json());

  // Liveness: process is up. Readiness: DB reachable. ScaleKV is reported but optional:
  // the API is still "ready" without it (it just runs slower, without shared rate limits).
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ready", kv: kv.status });
    } catch {
      res.status(503).json({ status: "db_unavailable" });
    }
  });

  // After the health checks (load balancers poll those constantly; they must never be limited).
  app.use(limits.global);
  app.use(apiRouter);

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  // Must be last: catches errors thrown by anything above.
  app.use(errorHandler);
  return app;
}
