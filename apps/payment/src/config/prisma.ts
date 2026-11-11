import { createPrisma } from "@scalecart/legacy-db";
import { env } from "./env.js";

// One client per process (it holds a connection pool). Phase 3: this service's OWN database.
export const prisma = createPrisma(env.DATABASE_URL, env.DATABASE_POOL_MAX);

/** What the service chassis needs: a readiness probe and a clean disconnect on shutdown. */
export const db = {
  ping: () => prisma.$queryRaw`SELECT 1`,
  disconnect: () => prisma.$disconnect(),
};
