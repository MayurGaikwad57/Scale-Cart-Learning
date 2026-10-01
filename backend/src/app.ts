import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { prisma } from "./config/prisma.js";

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.json());

  // Liveness: process is up. Readiness: DB reachable.
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "db_unavailable" });
    }
  });

  // Feature modules (users, products, inventory, cart, orders, payments) are mounted in M2.

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  return app;
}
