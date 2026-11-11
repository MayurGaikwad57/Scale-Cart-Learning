// Development seed: the admin account. Safe to run repeatedly (upsert by email).
//   npm run seed -w @scalecart/identity      (or: npm run seed from the repo root = identity + order)
import bcrypt from "bcryptjs";
import { prisma } from "../config/prisma.js";

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? "admin@scalecart.com").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "Admin@12345";

await prisma.user.upsert({
  where: { email: ADMIN_EMAIL },
  create: { email: ADMIN_EMAIL, passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10), role: "ADMIN" },
  update: { role: "ADMIN" },
});
console.log(`Seeded admin ${ADMIN_EMAIL}.`);
await prisma.$disconnect();
