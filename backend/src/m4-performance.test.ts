import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { kv } from "./config/kv.js";
import { prisma } from "./config/prisma.js";
import { startKvServer, type RunningKvServer } from "./kv/server.js";
import { cleanup, makeProduct, makeUser, RUN } from "./test-utils.js";

// M4: caching, rate limiting and idempotency, end-to-end through the HTTP API with a REAL
// ScaleKV server (in this process, on a random port).

const app = createApp();
let server: RunningKvServer;
let admin: Awaited<ReturnType<typeof makeUser>>;
type U = Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  server = await startKvServer({ port: 0 });
  kv.connect(`kv://127.0.0.1:${server.port}`);
  await kv.waitUntilReady();
  admin = await makeUser("ADMIN");
});
afterAll(async () => {
  await kv.disconnect();
  await server.close();
  await cleanup();
  await prisma.$disconnect();
});

const flush = () => server.store.execute(["FLUSHALL"]);
const getProduct = (id: string, auth?: Record<string, string>) => request(app).get(`/products/${id}`).set(auth ?? {});
const addToCart = (u: U, productId: string, quantity = 1) =>
  request(app).post("/cart/items").set(u.auth).send({ productId, quantity });
const placeOrder = (u: U, key?: string, paymentMethod = "TEST_CARD_SUCCESS") =>
  request(app)
    .post("/orders")
    .set({ ...u.auth, ...(key ? { "Idempotency-Key": key } : {}) })
    .send({ paymentMethod });
const ordersWithKey = (u: U, key: string) => prisma.order.count({ where: { userId: u.user.id, idempotencyKey: key } });

describe("cache-aside: product detail", () => {
  it("MISS first, HIT after; an admin edit invalidates it", async () => {
    const p = await makeProduct(5, { priceCents: 1000 });
    const first = await getProduct(p.id);
    expect(first.headers["x-cache"]).toBe("MISS");
    const second = await getProduct(p.id);
    expect(second.headers["x-cache"]).toBe("HIT");
    expect(second.body).toEqual(first.body);

    await request(app).put(`/products/${p.id}`).set(admin.auth).send({ priceCents: 1999 }).expect(200);
    const afterEdit = await getProduct(p.id);
    expect(afterEdit.headers["x-cache"]).toBe("MISS");
    expect(afterEdit.body.priceCents).toBe(1999);
  });

  it("a checkout invalidates the product, so customers never see the old stock", async () => {
    const p = await makeProduct(5);
    await getProduct(p.id);
    expect((await getProduct(p.id)).body.stock).toBe(5); // served from cache
    const u = await makeUser();
    await addToCart(u, p.id, 2);
    expect((await placeOrder(u)).status).toBe(201);
    const after = await getProduct(p.id);
    expect(after.headers["x-cache"]).toBe("MISS");
    expect(after.body.stock).toBe(3);
  });

  it("a slow reader's late write of OLD data after an invalidation is never served (versioned keys)", async () => {
    const p = await makeProduct(5, { priceCents: 1000 });
    const before = await getProduct(p.id); // cached under product:<id>:v0
    await request(app).put(`/products/${p.id}`).set(admin.auth).send({ priceCents: 2500 }).expect(200);
    // Simulate the race: a reader that loaded the OLD row before the commit stores it AFTER the
    // invalidation - with plain DEL this stale copy would now be served for 60s.
    server.store.execute(["SET", `product:${p.id}:v0`, JSON.stringify(before.body), "PX", "60000"]);
    const after = await getProduct(p.id);
    expect(after.body.priceCents).toBe(2500);
    expect((await getProduct(p.id)).headers["x-cache"]).toBe("HIT");
  });

  it("an admin stock update invalidates it too", async () => {
    const p = await makeProduct(5);
    await getProduct(p.id);
    await request(app).post("/inventory").set(admin.auth).send({ productId: p.id, available: 42 }).expect(200);
    expect((await getProduct(p.id)).body.stock).toBe(42);
  });

  it("a deleted (inactive) product disappears for customers even though it was cached", async () => {
    const p = await makeProduct(5);
    await getProduct(p.id).expect(200);
    await request(app).delete(`/products/${p.id}`).set(admin.auth).expect(204);
    await getProduct(p.id).expect(404);
    await getProduct(p.id, admin.auth).expect(200); // admins still see it
  });

  it("caches 'not found' briefly (cache penetration guard)", async () => {
    const ghost = randomUUID();
    await getProduct(ghost).expect(404);
    expect(server.store.execute(["GET", `product:${ghost}:v0`])).toBe("__null__");
    const ttl = server.store.execute(["PTTL", `product:${ghost}:v0`]) as number;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15_000 * 1.1);
    await getProduct(ghost).expect(404); // answered from the cache, no DB query
  });

  it("spreads TTLs randomly (avalanche guard)", async () => {
    const ps = await Promise.all([1, 2, 3, 4, 5, 6].map(() => makeProduct(1)));
    await Promise.all(ps.map((p) => getProduct(p.id)));
    const ttls = new Set(ps.map((p) => server.store.execute(["PTTL", `product:${p.id}:v0`])));
    expect(ttls.size).toBeGreaterThan(1);
  });
});

describe("checkout invalidates only what it must", () => {
  it("a sale refreshes that product's page but keeps the list cache; a declined payment invalidates nothing", async () => {
    const p = await makeProduct(10);
    const catalogVer = () => server.store.execute(["GET", "products:ver"]);
    const productVer = () => server.store.execute(["GET", `product:ver:${p.id}`]);
    const verBefore = catalogVer();

    const declined = await makeUser();
    await addToCart(declined, p.id);
    expect((await placeOrder(declined, undefined, "TEST_CARD_DECLINE")).body.status).toBe("CANCELLED");
    expect(productVer()).toBeNull(); // net stock unchanged -> nothing to invalidate

    const buyer = await makeUser();
    await addToCart(buyer, p.id);
    expect((await placeOrder(buyer)).status).toBe(201);
    expect(productVer()).toBe("1"); // product page refreshed
    expect(catalogVer()).toBe(verBefore); // list pages + categories untouched (hit rate survives)
  });
});

describe("cache-aside: catalog lists (versioned keys)", () => {
  it("caches a list page, and a new product bumps the version so lists refresh", async () => {
    const category = `${RUN}-list`;
    await makeProduct(1, { category });
    const q = { category };
    expect((await request(app).get("/products").query(q)).headers["x-cache"]).toBe("MISS");
    const hit = await request(app).get("/products").query(q);
    expect(hit.headers["x-cache"]).toBe("HIT");
    expect(hit.body.total).toBe(1);

    await request(app)
      .post("/products")
      .set(admin.auth)
      .send({ sku: `${RUN}-new-${randomUUID().slice(0, 6)}`, name: "New one", priceCents: 500, category, stock: 3 })
      .expect(201);
    const fresh = await request(app).get("/products").query(q);
    expect(fresh.headers["x-cache"]).toBe("MISS");
    expect(fresh.body.total).toBe(2);
  });

  it("admins bypass the cache (they must see their own edits immediately)", async () => {
    const res = await request(app).get("/products").set(admin.auth);
    expect(res.headers["x-cache"]).toBe("BYPASS");
  });
});

describe("admin system status", () => {
  it("shows ScaleKV and the API-side cache hit rate to admins only", async () => {
    const p = await makeProduct(1);
    await getProduct(p.id);
    await getProduct(p.id);
    const res = await request(app).get("/admin/system").set(admin.auth).expect(200);
    expect(res.body.kv.status).toBe("ready");
    expect(res.body.kv.stats.keys).toBeGreaterThan(0);
    expect(res.body.cache.hits).toBeGreaterThan(0);
    expect(res.body.cache.misses).toBeGreaterThan(0);
    await request(app).get("/admin/system").set((await makeUser()).auth).expect(403);
  });
});

describe("rate limiting (sliding window counter)", () => {
  beforeEach(flush);

  it("allows 10 login attempts per minute per IP, then answers 429 with Retry-After", async () => {
    const attempt = () => request(app).post("/auth/login").send({ email: `${RUN}-nobody@example.com`, password: "wrong-password" });
    for (let i = 0; i < 10; i++) {
      const res = await attempt();
      expect(res.status).toBe(401);
      expect(Number(res.headers["ratelimit-remaining"])).toBe(9 - i);
    }
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("too_many_requests");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("limits checkout per USER: another user is not affected", async () => {
    const greedy = await makeUser();
    const other = await makeUser();
    for (let i = 0; i < 10; i++) expect((await placeOrder(greedy)).status).toBe(400); // cart_empty, but counted
    expect((await placeOrder(greedy)).status).toBe(429);
    expect((await placeOrder(other)).status).toBe(400); // still allowed (empty cart)
  });
});

describe("idempotent order creation", () => {
  it("a retry with the same key returns the SAME order and does not charge/sell twice", async () => {
    const u = await makeUser();
    const p = await makeProduct(10);
    await addToCart(u, p.id, 2);
    const key = randomUUID();

    const first = await placeOrder(u, key);
    expect(first.status).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();

    await addToCart(u, p.id, 1); // even if the cart changed meanwhile...
    const retry = await placeOrder(u, key);
    expect(retry.status).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.body.id).toBe(first.body.id); // ...the retry is the same order, not a new one
    expect(await ordersWithKey(u, key)).toBe(1);
    expect((await prisma.inventory.findUniqueOrThrow({ where: { productId: p.id } })).available).toBe(8);
  });

  it("rejects the same key with a different request body (422)", async () => {
    const u = await makeUser();
    await addToCart(u, (await makeProduct(5)).id);
    const key = randomUUID();
    expect((await placeOrder(u, key, "TEST_CARD_SUCCESS")).status).toBe(201);
    const misuse = await placeOrder(u, key, "TEST_CARD_DECLINE");
    expect(misuse.status).toBe(422);
    expect(misuse.body.error).toBe("idempotency_key_reused");
  });

  it("two simultaneous requests with the same key create ONE order", async () => {
    const u = await makeUser();
    await addToCart(u, (await makeProduct(5)).id);
    const key = randomUUID();
    const [a, b] = await Promise.all([placeOrder(u, key), placeOrder(u, key)]);
    // Usually the loser is told 409 "in progress"; if it arrives after the winner finished it
    // gets the replayed 201. Either way: exactly one order.
    expect([a.status, b.status]).toContain(201);
    for (const r of [a, b]) expect([201, 409]).toContain(r.status);
    expect(await ordersWithKey(u, key)).toBe(1);
  });

  it("if the ScaleKV record is lost, the database still prevents a duplicate", async () => {
    const u = await makeUser();
    await addToCart(u, (await makeProduct(5)).id);
    const key = randomUUID();
    const first = await placeOrder(u, key);
    flush(); // simulate ScaleKV restart / eviction
    await addToCart(u, (await makeProduct(5)).id);
    const retry = await placeOrder(u, key);
    expect(retry.status).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.body.id).toBe(first.body.id);
    expect(await ordersWithKey(u, key)).toBe(1);
  });

  it("the database layer also rejects the same key with a different body (422)", async () => {
    const u = await makeUser();
    await addToCart(u, (await makeProduct(5)).id);
    const key = randomUUID();
    expect((await placeOrder(u, key, "TEST_CARD_DECLINE")).body.status).toBe("CANCELLED");
    flush(); // the fast ScaleKV record is gone - only the order row remembers the key
    const misuse = await placeOrder(u, key, "TEST_CARD_SUCCESS");
    expect(misuse.status).toBe(422);
    expect(misuse.body.error).toBe("idempotency_key_reused");
    expect(await ordersWithKey(u, key)).toBe(1);
  });

  it("a failed attempt releases the key so the same key can be retried after fixing the problem", async () => {
    const u = await makeUser();
    const key = randomUUID();
    expect((await placeOrder(u, key)).status).toBe(400); // cart empty -> nothing happened
    await addToCart(u, (await makeProduct(5)).id);
    expect((await placeOrder(u, key)).status).toBe(201);
  });

  it("keys are per user, and malformed keys are rejected", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    await addToCart(a, (await makeProduct(5)).id);
    await addToCart(b, (await makeProduct(5)).id);
    const key = randomUUID();
    const ra = await placeOrder(a, key);
    const rb = await placeOrder(b, key);
    expect(rb.status).toBe(201);
    expect(rb.body.id).not.toBe(ra.body.id);
    expect((await placeOrder(a, "bad key!")).status).toBe(400);
  });
});

// Keep this block LAST: it stops the ScaleKV server.
describe("when ScaleKV is down, the API degrades instead of failing", () => {
  it("serves from the database, doesn't rate limit (fail open), and the DB still dedupes orders", async () => {
    const port = server.port;
    await server.close();
    await expect.poll(() => kv.status).toBe("down");

    const p = await makeProduct(5);
    const res = await getProduct(p.id);
    expect(res.status).toBe(200);
    expect(res.headers["x-cache"]).toBe("BYPASS");

    for (let i = 0; i < 12; i++) {
      expect((await request(app).post("/auth/login").send({ email: `${RUN}-x@example.com`, password: "nope-nope" })).status).toBe(401);
    }

    const u = await makeUser();
    await addToCart(u, p.id);
    const key = randomUUID();
    const first = await placeOrder(u, key);
    await addToCart(u, p.id);
    const retry = await placeOrder(u, key);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.headers["idempotent-replayed"]).toBe("true");

    // ...and it heals by itself when ScaleKV is back.
    server = await startKvServer({ port });
    await kv.waitUntilReady(6000);
    await getProduct(p.id);
    expect((await getProduct(p.id)).headers["x-cache"]).toBe("HIT");
  }, 20_000);
});
