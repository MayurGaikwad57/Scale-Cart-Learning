import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

/**
 * TEMPORARY - the one shared database (M6.5 phase 2).
 * Every service still reads and writes the same PostgreSQL database through this one schema.
 * That is the last thing that makes ScaleCart a "distributed monolith": phase 3 gives each service
 * its OWN database + schema + migrations and deletes this package.
 */
export { Prisma, PrismaClient } from "../generated/prisma/client.js";

/** One client per process (it holds a pool of at most `max` connections), created by the service that uses it. */
export const createPrisma = (connectionString: string, max = 10) => new PrismaClient({ adapter: new PrismaPg({ connectionString, max }) });
