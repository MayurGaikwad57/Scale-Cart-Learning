import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "./config/env.js";
import { prisma } from "./config/prisma.js";

// Test helpers: create users/products straight in the DB (fast, no bcrypt) and tag them with a
// per-run prefix so cleanup only ever deletes rows this run created.
export const RUN = `t${Date.now()}${Math.floor(Math.random() * 1000)}`;

export async function makeUser(role: "CUSTOMER" | "ADMIN" = "CUSTOMER") {
  const user = await prisma.user.create({
    data: { email: `${RUN}-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x", role },
  });
  const token = jwt.sign({ role }, env.JWT_SECRET, { subject: user.id, expiresIn: "1h" });
  return { user, auth: { Authorization: `Bearer ${token}` } };
}

export const makeProduct = (stock: number, over: { priceCents?: number; category?: string; name?: string; active?: boolean } = {}) =>
  prisma.product.create({
    data: {
      sku: `${RUN}-${randomUUID().slice(0, 8)}`,
      name: over.name ?? `Test product ${RUN}`,
      priceCents: over.priceCents ?? 1000,
      category: over.category ?? `${RUN}-cat`,
      active: over.active ?? true,
      inventory: { create: { available: stock } },
    },
  });

export async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: `${RUN}-` } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const products = await prisma.product.findMany({ where: { sku: { startsWith: `${RUN}-` } }, select: { id: true } });
  const productIds = products.map((p) => p.id);
  const orders = await prisma.order.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { productId: { in: productIds } }] } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.cartItem.deleteMany({ where: { productId: { in: productIds } } });
  await prisma.cart.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.product.deleteMany({ where: { id: { in: productIds } } }); // inventory cascades
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}
