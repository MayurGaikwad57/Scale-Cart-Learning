import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import { env } from "./env.js";

// Prisma 7 connects through a driver adapter (node-postgres). One client per process.
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

/** What the service chassis needs: a readiness probe and a clean disconnect on shutdown. */
export const db = {
  ping: () => prisma.$queryRaw`SELECT 1`,
  disconnect: () => prisma.$disconnect(),
};
