// Development seed: one admin account + sample products. Safe to run repeatedly (upserts by email / sku).
//   npm run seed
import bcrypt from "bcryptjs";
import { prisma } from "../config/prisma.js";

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

  for (const [sku, name, description, priceCents, category, stock] of products) {
    await prisma.product.upsert({
      where: { sku },
      // Stock is only set on first creation, so re-seeding never resets stock you've changed.
      create: { sku, name, description, priceCents, category, inventory: { create: { available: stock } } },
      update: { name, description, priceCents, category },
    });
  }
  console.log(`Seeded admin ${ADMIN_EMAIL} and ${products.length} products.`);
}

main().finally(() => prisma.$disconnect());
