import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../config/prisma.js";
import { cleanup, makeProduct, makeUser } from "../../test-utils.js";

const app = createApp();
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const addToCart = (u: Awaited<ReturnType<typeof makeUser>>, productId: string, quantity = 1) =>
  request(app).post("/cart/items").set(u.auth).send({ productId, quantity });
const checkout = (u: Awaited<ReturnType<typeof makeUser>>, paymentMethod = "TEST_CARD_SUCCESS") =>
  request(app).post("/orders").set(u.auth).send({ paymentMethod });
const stock = (productId: string) => prisma.inventory.findUniqueOrThrow({ where: { productId } });

describe("cart", () => {
  it("adds, merges duplicates, updates, removes, and computes totals", async () => {
    const u = await makeUser();
    const a = await makeProduct(10, { priceCents: 1000 });
    const b = await makeProduct(10, { priceCents: 250 });
    await addToCart(u, a.id, 2);
    await addToCart(u, a.id, 1); // same product merges into one line
    const cart = (await addToCart(u, b.id, 4)).body;
    expect(cart.items).toHaveLength(2);
    expect(cart.itemCount).toBe(7);
    expect(cart.totalCents).toBe(3 * 1000 + 4 * 250);

    const line = cart.items.find((i: { productId: string }) => i.productId === a.id);
    const updated = await request(app).put(`/cart/items/${line.id}`).set(u.auth).send({ quantity: 5 });
    expect(updated.body.totalCents).toBe(5 * 1000 + 4 * 250);
    const removed = await request(app).delete(`/cart/items/${line.id}`).set(u.auth);
    expect(removed.body.items).toHaveLength(1);
  });

  it("refuses more than the stock, inactive products, and bad quantities", async () => {
    const u = await makeUser();
    const p = await makeProduct(2);
    expect((await addToCart(u, p.id, 3)).status).toBe(409);
    expect((await addToCart(u, p.id, 0)).status).toBe(400);
    const gone = await makeProduct(5, { active: false });
    expect((await addToCart(u, gone.id)).status).toBe(404);
  });

  it("cannot touch another user's cart item (404) and requires login (401)", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const p = await makeProduct(5);
    const item = (await addToCart(owner, p.id)).body.items[0];
    expect((await request(app).delete(`/cart/items/${item.id}`).set(other.auth)).status).toBe(404);
    expect((await request(app).put(`/cart/items/${item.id}`).set(other.auth).send({ quantity: 2 })).status).toBe(404);
    expect((await request(app).get("/cart")).status).toBe(401);
  });
});

describe("checkout: happy path", () => {
  it("creates a CONFIRMED order, sells the stock, snapshots prices, empties the cart", async () => {
    const u = await makeUser();
    const p = await makeProduct(5, { priceCents: 1200 });
    await addToCart(u, p.id, 2);
    const res = await checkout(u);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("CONFIRMED");
    expect(res.body.totalCents).toBe(2400);
    expect(res.body.items[0]).toMatchObject({ quantity: 2, unitPriceCents: 1200 });
    expect(res.body.payment).toEqual({ status: "SUCCEEDED", amountCents: 2400 });
    expect(await stock(p.id)).toMatchObject({ available: 3, reserved: 0 });
    expect((await request(app).get("/cart").set(u.auth)).body.items).toHaveLength(0);

    // Changing the price later must not rewrite history.
    await prisma.product.update({ where: { id: p.id }, data: { priceCents: 9999 } });
    const again = await request(app).get(`/orders/${res.body.id}`).set(u.auth);
    expect(again.body.items[0].unitPriceCents).toBe(1200);
  });

  it("lists order history newest-first with pagination", async () => {
    const u = await makeUser();
    const p = await makeProduct(10);
    for (let i = 0; i < 3; i++) {
      await addToCart(u, p.id);
      await checkout(u);
    }
    const list = await request(app).get("/orders").query({ pageSize: 2 }).set(u.auth);
    expect(list.body.total).toBe(3);
    expect(list.body.items).toHaveLength(2);
    const t = list.body.items.map((o: { createdAt: string }) => +new Date(o.createdAt));
    expect(t[0]).toBeGreaterThanOrEqual(t[1]);
  });

  it("rejects an empty cart (400) and hides other users' orders (404)", async () => {
    const u = await makeUser();
    expect((await checkout(u)).status).toBe(400);
    const p = await makeProduct(2);
    await addToCart(u, p.id);
    const order = (await checkout(u)).body;
    const stranger = await makeUser();
    expect((await request(app).get(`/orders/${order.id}`).set(stranger.auth)).status).toBe(404);
  });
});

describe("checkout: payment failure (compensation)", () => {
  it("cancels the order, releases the reserved stock, and keeps the cart for a retry", async () => {
    const u = await makeUser();
    const p = await makeProduct(4);
    await addToCart(u, p.id, 3);
    const res = await checkout(u, "TEST_CARD_DECLINE");
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("CANCELLED");
    expect(res.body.payment.status).toBe("FAILED");
    expect(await stock(p.id)).toMatchObject({ available: 4, reserved: 0 }); // fully restored
    expect((await request(app).get("/cart").set(u.auth)).body.itemCount).toBe(3);
    expect((await checkout(u, "TEST_CARD_SUCCESS")).body.status).toBe("CONFIRMED"); // retry works
  });
});

describe("checkout: concurrency (the reason we use row locks)", () => {
  it("two buyers, one item left: exactly one wins, stock never goes negative", async () => {
    const p = await makeProduct(1);
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    await addToCart(a, p.id);
    await addToCart(b, p.id);
    const results = await Promise.all([checkout(a), checkout(b)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe("insufficient_stock");
    expect(await stock(p.id)).toMatchObject({ available: 0, reserved: 0 });
    expect(await prisma.orderItem.count({ where: { productId: p.id } })).toBe(1);
  });

  it("10 buyers, 3 items: exactly 3 orders succeed", async () => {
    const p = await makeProduct(3);
    const users = await Promise.all(Array.from({ length: 10 }, () => makeUser()));
    await Promise.all(users.map((u) => addToCart(u, p.id)));
    const results = await Promise.all(users.map((u) => checkout(u)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    expect(await stock(p.id)).toMatchObject({ available: 0, reserved: 0 });
  });

  it("carts sharing products in different orders do not deadlock", async () => {
    const [p1, p2] = await Promise.all([makeProduct(50), makeProduct(50)]);
    const users = await Promise.all(Array.from({ length: 8 }, () => makeUser()));
    // Half add p1 first, half add p2 first: opposite "natural" order, same lock order in checkout.
    await Promise.all(users.map(async (u, i) => {
      const [first, second] = i % 2 ? [p1, p2] : [p2, p1];
      await addToCart(u, first.id);
      await addToCart(u, second.id);
    }));
    const results = await Promise.all(users.map((u) => checkout(u)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await stock(p1.id)).toMatchObject({ available: 42 });
  });

  it("a double-click on 'Place order' creates only one order", async () => {
    const u = await makeUser();
    const p = await makeProduct(10);
    await addToCart(u, p.id, 2);
    const results = await Promise.all([checkout(u), checkout(u)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(await prisma.order.count({ where: { userId: u.user.id } })).toBe(1);
    expect(await stock(p.id)).toMatchObject({ available: 8, reserved: 0 });
  });

  it("if one line is short, nothing is reserved at all (atomic rollback)", async () => {
    const u = await makeUser();
    const plenty = await makeProduct(10);
    const scarce = await makeProduct(5);
    await addToCart(u, plenty.id, 2);
    await addToCart(u, scarce.id, 5);
    await prisma.inventory.update({ where: { productId: scarce.id }, data: { available: 1 } }); // someone else bought it
    const res = await checkout(u);
    expect(res.status).toBe(409);
    expect(await stock(plenty.id)).toMatchObject({ available: 10, reserved: 0 });
    expect(await prisma.order.count({ where: { userId: u.user.id } })).toBe(0);
  });
});
