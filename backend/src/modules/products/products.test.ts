import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../config/prisma.js";
import { cleanup, makeProduct, makeUser, RUN } from "../../test-utils.js";

const app = createApp();
const cat = `${RUN}-cat`;
let admin: Awaited<ReturnType<typeof makeUser>>;
let customer: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  admin = await makeUser("ADMIN");
  customer = await makeUser("CUSTOMER");
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("products: reading", () => {
  it("paginates, filters by category, sorts by price, and reports stock", async () => {
    await Promise.all([1500, 500, 1000, 2500, 2000].map((p) => makeProduct(7, { priceCents: p })));
    const res = await request(app).get("/products").query({ category: cat, sort: "price_asc", page: 1, pageSize: 2 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.items.map((i: { priceCents: number }) => i.priceCents)).toEqual([500, 1000]);
    expect(res.body.items[0].stock).toBe(7);

    const page3 = await request(app).get("/products").query({ category: cat, sort: "price_asc", page: 3, pageSize: 2 });
    expect(page3.body.items.map((i: { priceCents: number }) => i.priceCents)).toEqual([2500]);
  });

  it("filters by price range (cents) and text search", async () => {
    const res = await request(app).get("/products").query({ category: cat, minPrice: 1000, maxPrice: 2000 });
    expect(res.body.total).toBe(3);
    await makeProduct(1, { name: `Zebra-${RUN}-unique` });
    const found = await request(app).get("/products").query({ q: `zebra-${RUN}` });
    expect(found.body.total).toBe(1);
  });

  it("rejects invalid query params with 400", async () => {
    expect((await request(app).get("/products").query({ pageSize: 500 })).status).toBe(400);
    expect((await request(app).get("/products").query({ sort: "bogus" })).status).toBe(400);
  });

  it("returns 400 for a malformed id and 404 for an unknown one", async () => {
    expect((await request(app).get("/products/not-a-uuid")).status).toBe(400);
    expect((await request(app).get("/products/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});

describe("products: admin writes", () => {
  it("blocks anonymous (401) and customers (403)", async () => {
    const body = { sku: `${RUN}-x`, name: "x", priceCents: 100, category: cat };
    expect((await request(app).post("/products").send(body)).status).toBe(401);
    expect((await request(app).post("/products").set(customer.auth).send(body)).status).toBe(403);
  });

  it("admin creates (with stock), updates, and soft-deletes; deleted products vanish for the public", async () => {
    const created = await request(app).post("/products").set(admin.auth)
      .send({ sku: `${RUN}-crud`, name: "Widget", priceCents: 1999, category: cat, stock: 5 });
    expect(created.status).toBe(201);
    expect(created.body.stock).toBe(5);
    const id = created.body.id;

    const dup = await request(app).post("/products").set(admin.auth)
      .send({ sku: `${RUN}-crud`, name: "Dup", priceCents: 1, category: cat });
    expect(dup.status).toBe(409);

    const upd = await request(app).put(`/products/${id}`).set(admin.auth).send({ priceCents: 2499 });
    expect(upd.body.priceCents).toBe(2499);
    expect(upd.body.name).toBe("Widget");

    expect((await request(app).delete(`/products/${id}`).set(admin.auth)).status).toBe(204);
    expect((await request(app).get(`/products/${id}`)).status).toBe(404);
    expect((await request(app).get(`/products/${id}`).set(admin.auth)).status).toBe(200); // admin still sees it
    const publicList = await request(app).get("/products").query({ category: cat });
    expect(publicList.body.items.some((i: { id: string }) => i.id === id)).toBe(false);
    const adminList = await request(app).get("/products").query({ category: cat, includeInactive: "true" }).set(admin.auth);
    expect(adminList.body.items.some((i: { id: string }) => i.id === id)).toBe(true);
  });

  it("validates the body", async () => {
    const res = await request(app).post("/products").set(admin.auth).send({ sku: "", name: "x", priceCents: -5, category: "c" });
    expect(res.status).toBe(400);
  });
});

describe("inventory", () => {
  it("anyone can read, only admin can set; reserved is untouched", async () => {
    const p = await makeProduct(3);
    expect((await request(app).get(`/inventory/${p.id}`)).body).toEqual({ productId: p.id, available: 3, reserved: 0 });
    expect((await request(app).post("/inventory").set(customer.auth).send({ productId: p.id, available: 9 })).status).toBe(403);
    const res = await request(app).post("/inventory").set(admin.auth).send({ productId: p.id, available: 9 });
    expect(res.body.available).toBe(9);
    expect((await request(app).post("/inventory").set(admin.auth).send({ productId: p.id, available: -1 })).status).toBe(400);
    const ghost = await request(app).post("/inventory").set(admin.auth).send({ productId: "00000000-0000-4000-8000-000000000000", available: 1 });
    expect(ghost.status).toBe(404);
  });
});
