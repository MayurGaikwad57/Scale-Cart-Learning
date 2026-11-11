import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { env } from "./env.js";

// One client per process to THIS service's own database (users). Nobody else can connect to it.
export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.IDENTITY_DATABASE_URL, max: env.DATABASE_POOL_MAX }) });

/** What the service chassis needs: a readiness probe and a clean disconnect on shutdown. */
export const db = {
  ping: () => prisma.$queryRaw`SELECT 1`,
  disconnect: () => prisma.$disconnect(),
};
