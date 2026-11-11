import { randomUUID } from "node:crypto";
import { signToken } from "@scalecart/identity/keys";
import { identityDb, inventoryDb, notificationDb, orderDb, paymentDb } from "./db.js";

// Test helpers: create users/products straight in the DB (fast, no bcrypt) and tag them with a
// per-run prefix so cleanup only ever deletes rows this run created.
export const RUN = `t${Date.now()}${Math.floor(Math.random() * 1000)}`;

export async function makeUser(role: "CUSTOMER" | "ADMIN" = "CUSTOMER") {
  // Users live in the IDENTITY service's database; the token is signed exactly like a real login (RS256).
  const user = await identityDb.user.create({
    data: { email: `${RUN}-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x", role },
  });
  const token = signToken(user);
  return { user, auth: { Authorization: `Bearer ${token}` } };
}

/**
 * A test product = a row in the ORDER service's database (with its stock copy) + its stock row and
 * product info in the INVENTORY service's database. In the running system the second half happens
 * through the ProductCreated event; tests write both directly so they don't depend on event timing.
 */
export async function makeProduct(stock: number, over: { priceCents?: number; category?: string; name?: string; active?: boolean } = {}) {
  const product = await orderDb.product.create({
    data: {
      sku: `${RUN}-${randomUUID().slice(0, 8)}`,
      name: over.name ?? `Test product ${RUN}`,
      priceCents: over.priceCents ?? 1000,
      category: over.category ?? `${RUN}-cat`,
      active: over.active ?? true,
      stockAvailable: stock,
      stockVersion: 0,
    },
  });
  await inventoryDb.inventory.create({ data: { productId: product.id, available: stock } });
  await inventoryDb.productInfo.create({ data: { productId: product.id, sku: product.sku, name: product.name } });
  return product;
}

/** Many test products at once: 3 bulk inserts instead of 3 x n single ones (no load spike on the pools). */
export async function makeProducts(n: number, stock: number) {
  const rows = Array.from({ length: n }, () => ({
    id: randomUUID(),
    sku: `${RUN}-${randomUUID().slice(0, 8)}`,
    name: `Test product ${RUN}`,
    priceCents: 1000,
    category: `${RUN}-cat`,
  }));
  await orderDb.product.createMany({ data: rows.map((r) => ({ ...r, stockAvailable: stock, stockVersion: 0 })) });
  await inventoryDb.inventory.createMany({ data: rows.map((r) => ({ productId: r.id, available: stock })) });
  await inventoryDb.productInfo.createMany({ data: rows.map((r) => ({ productId: r.id, sku: r.sku, name: r.name })) });
  return rows;
}

/** Delete everything this run created - in EVERY service's database (no cross-database cascades). */
export async function cleanup() {
  const users = await identityDb.user.findMany({ where: { email: { startsWith: `${RUN}-` } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const products = await orderDb.product.findMany({ where: { sku: { startsWith: `${RUN}-` } }, select: { id: true } });
  const productIds = products.map((p) => p.id);
  const orders = await orderDb.order.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  // payment service
  await paymentDb.payment.deleteMany({ where: { orderId: { in: orderIds } } });
  // notification service
  await notificationDb.notification.deleteMany({ where: { userId: { in: userIds } } });
  // inventory service
  await inventoryDb.reservation.deleteMany({ where: { orderId: { in: orderIds } } }); // items cascade (same DB)
  await inventoryDb.reservationItem.deleteMany({ where: { productId: { in: productIds } } });
  await inventoryDb.stockAlert.deleteMany({ where: { productId: { in: productIds } } });
  await inventoryDb.inventory.deleteMany({ where: { productId: { in: productIds } } });
  await inventoryDb.productInfo.deleteMany({ where: { productId: { in: productIds } } });
  // order service
  await orderDb.orderItem.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { productId: { in: productIds } }] } });
  await orderDb.order.deleteMany({ where: { id: { in: orderIds } } });
  await orderDb.cartItem.deleteMany({ where: { productId: { in: productIds } } });
  await orderDb.cart.deleteMany({ where: { userId: { in: userIds } } });
  await orderDb.product.deleteMany({ where: { id: { in: productIds } } });
  // identity service
  await identityDb.user.deleteMany({ where: { id: { in: userIds } } });
}
