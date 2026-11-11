// Development seed: one admin account + sample products. Safe to run repeatedly (upserts by email / sku).
//   npm run seed        (with ScaleLog running: npm run dev)
//
// M6.5: products live in the ORDER service's database, their stock in the INVENTORY service's. The
// seed creates the products here and publishes ProductCreated for each NEW one; the inventory
// service creates the stock rows from those events (it is the only one that writes its database).
import { deterministicEventId, makeEvent, type ProductCreated } from "@scalecart/events";
import { broker } from "@scalecart/service-kit/broker";
import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { publishProductEvent } from "../events/publish.js";

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? "admin@scalecart.com").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "Admin@12345";

// [sku, name, description, price in cents, category, stock]
const products: [string, string, string, number, string, number][] = [
  ["ELEC-001", "Wireless Headphones", "Over-ear Bluetooth headphones with 30h battery.", 5999_00, "Electronics", 25],
  ["ELEC-002", "Mechanical Keyboard", "Hot-swappable keys, RGB backlight.", 4499_00, "Electronics", 15],
  ["ELEC-003", "USB-C Fast Charger 65W", "Charges a laptop and a phone together.", 1799_00, "Electronics", 60],
  ["ELEC-004", "27-inch 4K Monitor", "IPS panel, 60Hz, HDMI + DisplayPort.", 24999_00, "Electronics", 8],
  ["ELEC-005", "Limited Edition Smartwatch", "Only ONE left. Try buying it from two browsers at once!", 12999_00, "Electronics", 1],
  ["BOOK-001", "Designing Data-Intensive Applications", "The classic on distributed systems.", 2999_00, "Books", 40],
  ["BOOK-002", "Clean Code", "A handbook of agile software craftsmanship.", 1499_00, "Books", 35],
  ["BOOK-003", "System Design Interview", "An insider's guide.", 1999_00, "Books", 0],
  ["HOME-001", "Ceramic Coffee Mug Set (4)", "Dishwasher safe, 350ml each.", 899_00, "Home", 50],
  ["HOME-002", "LED Desk Lamp", "Adjustable brightness and colour temperature.", 1299_00, "Home", 30],
  ["HOME-003", "Memory Foam Pillow", "Ergonomic neck support.", 1099_00, "Home", 22],
  ["FASH-001", "Cotton T-Shirt", "100% cotton, regular fit.", 499_00, "Fashion", 100],
  ["FASH-002", "Running Shoes", "Lightweight, breathable mesh.", 3499_00, "Fashion", 18],
  ["FASH-003", "Canvas Backpack", "20L, laptop sleeve, water resistant.", 1999_00, "Fashion", 27],
];

async function main() {
  await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    create: { email: ADMIN_EMAIL, passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10), role: "ADMIN" },
    update: { role: "ADMIN" },
  });

  if (!env.LOG_URL) throw new Error("LOG_URL is not set: the seed announces new products to the inventory service through ScaleLog");
  broker.conn.connect(env.LOG_URL);
  await broker.conn.waitUntilReady(5000).catch(() => {
    throw new Error("ScaleLog is not running - start everything with `npm run dev` first, then run the seed");
  });

  let created = 0;
  for (const [sku, name, description, priceCents, category, stock] of products) {
    const existing = await prisma.product.findUnique({ where: { sku } });
    // Stock is only set on first creation, so re-seeding never resets stock you've changed.
    const p = existing
      ? await prisma.product.update({ where: { sku }, data: { name, description, priceCents, category } })
      : await prisma.product.create({ data: { sku, name, description, priceCents, category, stockAvailable: stock } });
    if (!existing) {
      created++;
      const ok = await publishProductEvent(
        makeEvent<ProductCreated>("ProductCreated", 1, { productId: p.id, sku, name, initialStock: stock }, deterministicEventId("ProductCreated", p.id)),
      );
      if (!ok) throw new Error(`could not announce ${sku} to the inventory service (ScaleLog down?)`);
    }
  }
  console.log(`Seeded admin ${ADMIN_EMAIL} and ${products.length} products (${created} new, announced to the inventory service).`);
}

main().finally(async () => {
  await broker.conn.disconnect();
  await prisma.$disconnect();
});
