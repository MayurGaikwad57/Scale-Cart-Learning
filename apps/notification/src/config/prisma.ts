import { PrismaPg } from "@prisma/adapter-pg";
import { prismaDb } from "@scalecart/service-kit/service-app";
import { PrismaClient } from "../generated/prisma/client.js";
import { env } from "./env.js";

// One client per process (it holds a pool of at most DATABASE_POOL_MAX connections) to THIS
// service's own database. No other service has the address or the credentials of this database.
export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.NOTIFICATION_DATABASE_URL, max: env.DATABASE_POOL_MAX }) });

/** What the service chassis needs: a readiness probe and a clean disconnect on shutdown. */
export const db = prismaDb(prisma);
