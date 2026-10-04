import { prisma } from "../../config/prisma.js";

export const usersRepository = {
  findByEmail: (email: string) => prisma.user.findUnique({ where: { email } }),

  // Role is never taken from the client: new accounts are always CUSTOMER (schema default).
  create: (email: string, passwordHash: string) =>
    prisma.user.create({
      data: { email, passwordHash },
      select: { id: true, email: true, role: true, createdAt: true },
    }),
};
