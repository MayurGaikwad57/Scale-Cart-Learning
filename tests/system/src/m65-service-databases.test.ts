import { randomUUID } from "node:crypto";
import type { Express } from "express";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INVENTORY_TOPIC, makeEvent, TOPIC_PARTITIONS, type StockChanged } from "@scalecart/events";
import { productStockHandler } from "@scalecart/order/product-stock.handler";
import { publish } from "@scalecart/service-kit/publisher";
import { disconnectAll, inventoryDb, orderDb } from "./db.js";
import { eventually, startCluster, type Cluster } from "./test-cluster.js";
import { cleanup, makeProduct, makeUser, RUN } from "./test-utils.js";

/**
 * M6.5 phase 3 - DATABASE PER SERVICE. What changes when the services no longer share a database:
 * the boundary is enforced by PostgreSQL, data that used to be JOINed is now COPIED via events,
 * and those copies must cope with events arriving late, twice, or out of order.
 */
let cluster: Cluster;
let app: Express;
let admin: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  cluster = await startCluster({ log: true });
  app = cluster.gateway;
  admin = await makeUser("ADMIN");
});

afterAll(async () => {
  try {
    await cluster.close();
    await cleanup();
  } finally {
    await disconnectAll();
  }
});

describe("the boundary is enforced by the database", () => {
  it("a service's DB user can open its own database but NOT another service's", async () => {
    const own = new pg.Client({ connectionString: process.env.PAYMENT_DATABASE_URL });
    await own.connect();
    expect((await own.query("SELECT current_database() AS db")).rows[0].db).toBe("scalecart_payment");
    await own.end();

    const sneaky = new URL(process.env.PAYMENT_DATABASE_URL!); // payment's user + password ...
    sneaky.pathname = new URL(process.env.ORDER_DATABASE_URL!).pathname; // ... the ORDER database
    const other = new pg.Client({ connectionString: sneaky.toString() });
    await expect(other.connect()).rejects.toThrow(/permission denied for database/);
    await other.end().catch(() => undefined);
  });
});

describe("data that was JOINed is now copied through events", () => {
  it("an admin creates a product with stock: the INVENTORY service creates its stock row from ProductCreated", async () => {
    const created = await request(app)
      .post("/products")
      .set(admin.auth)
      .send({ sku: `${RUN}-new-${randomUUID().slice(0, 6)}`, name: "Event-born product", priceCents: 700, category: `${RUN}-cat`, stock: 4 })
      .expect(201);
    expect(created.body.stock).toBe(4); // the order service's own copy, immediately
    const row = await eventually(() => inventoryDb.inventory.findUnique({ where: { productId: created.body.id } }));
    expect(row).toMatchObject({ available: 4, reserved: 0 });
    expect(await inventoryDb.productInfo.findUnique({ where: { productId: created.body.id } })).toMatchObject({ name: "Event-born product" });
    // ...and the stock can now be bought (the checkout asks the inventory service).
    await request(app).get(`/inventory/${created.body.id}`).expect(200);
  });

  it("renaming a product updates the inventory service's copy (ProductUpdated)", async () => {
    const p = await makeProduct(3);
    await request(app).put(`/products/${p.id}`).set(admin.auth).send({ name: "Renamed" }).expect(200);
    await eventually(async () => (await inventoryDb.productInfo.findUnique({ where: { productId: p.id } }))?.name === "Renamed");
  });

  it("an admin stock change reaches the order service's copy (StockChanged with the number)", async () => {
    const p = await makeProduct(5);
    await request(app).post("/inventory").set(admin.auth).send({ productId: p.id, available: 11 }).expect(200);
    await eventually(async () => (await orderDb.product.findUnique({ where: { id: p.id } }))?.stockAvailable === 11);
    expect((await request(app).get(`/products/${p.id}`)).body.stock).toBe(11);
  });

  it("an OLD StockChanged arriving late never overwrites a newer number (versioned copy)", async () => {
    const p = await makeProduct(5);
    await request(app).post("/inventory").set(admin.auth).send({ productId: p.id, available: 9 }).expect(200); // version 1
    await eventually(async () => (await orderDb.product.findUnique({ where: { id: p.id } }))?.stockVersion === 1);
    // A replayed / delayed event from BEFORE that change (version 0, available 5), handled directly:
    const stale = makeEvent<StockChanged>("StockChanged", 2, { productId: p.id, cause: "reservation", available: 5, version: 0 });
    expect(await productStockHandler(stale)).toBe("stale");
    expect(await orderDb.product.findUnique({ where: { id: p.id } })).toMatchObject({ stockAvailable: 9, stockVersion: 1 });
    // ...and the same old event through the real broker: still ignored.
    await publish({ topic: INVENTORY_TOPIC, key: p.id, partitions: TOPIC_PARTITIONS, event: stale, mode: "must" });
    await new Promise((r) => setTimeout(r, 500));
    expect((await orderDb.product.findUnique({ where: { id: p.id } }))?.stockAvailable).toBe(9);
  });

  it("the admin Events page gets low-stock alerts by ASKING the inventory service", async () => {
    const p = await makeProduct(2, { name: "Almost gone" });
    await inventoryDb.stockAlert.create({ data: { productId: p.id, available: 2 } });
    const res = await request(app).get("/admin/events/projections").set(admin.auth).expect(200);
    expect(res.body.stockAlerts).toEqual(expect.arrayContaining([expect.objectContaining({ productId: p.id, name: "Almost gone", available: 2 })]));
  });

  it("if the inventory service is down, the Events page still answers (sales only, no alerts)", async () => {
    await cluster.stop("inventory");
    try {
      const res = await request(app).get("/admin/events/projections").set(admin.auth).expect(200);
      expect(res.body.stockAlerts).toEqual([]);
    } finally {
      await cluster.restart("inventory");
    }
  });
});
