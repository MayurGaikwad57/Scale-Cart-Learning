/**
 * What the chassis needs from a service's database - and nothing that pulls in the HTTP layer, so a
 * seed script or a tool can import its service's config/prisma.ts without loading Express & co.
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
