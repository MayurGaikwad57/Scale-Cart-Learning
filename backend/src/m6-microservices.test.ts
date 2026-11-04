import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { broker } from "./config/broker.js";
import { env } from "./config/env.js";
import { prisma } from "./config/prisma.js";
import { makeEvent, ORDERS_TOPIC, publisherStats, publishEvent, type OrderCreated } from "./events/order-events.js";
import { startWorkers } from "./events/workers.js";
import { serviceUrls } from "./services/registry.js";
import { reconcileOnce } from "./services/order/reconciler.js";
import { eventually, settle, startCluster, type Cluster } from "./test-cluster.js";
import { cleanup, makeProduct, makeUser } from "./test-utils.js";

// M6: the things that only exist BECAUSE the system is now distributed - the gateway, calls between
// services that fail or time out, a service that is down, lost events, and duplicate deliveries.

let cluster: Cluster;
let app: Express;
let admin: Awaited<ReturnType<typeof makeUser>>;
type U = Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  // The payment service starts "down" (its consumer group is not running) - see the first test.
  cluster = await startCluster({ log: true, groups: ["order", "inventory", "notification"] });
  app = cluster.gateway;
  admin = await makeUser("ADMIN");
});
afterAll(async () => {
  try {
    await cluster.close();
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
});

const buy = async (u: U, productId: string, quantity = 1, paymentMethod = "TEST_CARD_SUCCESS") => {
  await request(app).post("/cart/items").set(u.auth).send({ productId, quantity }).expect(201);
  return request(app).post("/orders").set(u.auth).send({ paymentMethod });
};
const stock = (productId: string) => prisma.inventory.findUniqueOrThrow({ where: { productId } });
const internal = { "x-internal-token": env.INTERNAL_TOKEN };

describe("asynchronous payment: the payment service can be down", () => {
  it("orders wait in PENDING while it is down, and are charged when it comes back - nothing is lost", async () => {
    const u = await makeUser();
    const p = await makeProduct(5);
    const res = await buy(u, p.id, 2);
    expect(res.status).toBe(201); // the customer is NOT blocked by the missing payment service
    await new Promise((r) => setTimeout(r, 800));
    expect((await request(app).get(`/orders/${res.body.id}`).set(u.auth)).body.status).toBe("PENDING");
    expect(await stock(p.id)).toMatchObject({ available: 3, reserved: 2 }); // held for this order

    startWorkers(["payment"], { log: false }); // the payment service starts
    expect((await settle(app, u.auth, res.body.id)).status).toBe("CONFIRMED");
    await eventually(async () => (await stock(p.id)).reserved === 0);
  });
});

describe("API gateway", () => {
  it("routes each path to its service and gives every request a correlation id", async () => {
    const u = await makeUser();
    const res = await request(app).get("/notifications").set(u.auth).set("X-Request-Id", "my-trace-123").expect(200);
    expect(res.headers["x-request-id"]).toBe("my-trace-123"); // kept end-to-end
    const generated = await request(app).get("/products");
    expect(generated.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects missing tokens at the edge, and never forwards /internal", async () => {
    expect((await request(app).get("/orders")).status).toBe(401);
    expect((await request(app).get("/notifications")).status).toBe(401);
    expect((await request(app).get("/admin/payments").set((await makeUser()).auth)).status).toBe(403);
    // The route exists on the inventory service, but the gateway pretends it doesn't.
    expect((await request(app).post("/internal/reservations").set(internal).send({})).status).toBe(404);
  });

  it("internal endpoints refuse callers without the service token, even when reached directly", async () => {
    const res = await fetch(`${serviceUrls.inventory}/internal/reservations/${randomUUID()}`);
    expect(res.status).toBe(403);
  });

  it("a stopped service becomes a quick 502 for ITS routes only; the rest of the site works", async () => {
    const u = await makeUser();
    await cluster.stop("notification");
    try {
      const res = await request(app).get("/notifications").set(u.auth);
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ error: "service_unavailable", service: "notification" });
      expect((await request(app).get("/products")).status).toBe(200); // order service unaffected
      const health = await request(app).get("/health/ready");
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ status: "degraded", services: { notification: "down", order: "up" } });
    } finally {
      await cluster.restart("notification");
    }
    expect((await request(app).get("/notifications").set(u.auth)).status).toBe(200);
  });

  it("admin > services shows every service, its routes, consumer groups and traffic", async () => {
    const res = await request(app).get("/admin/services").set(admin.auth).expect(200);
    const byName = Object.fromEntries(res.body.services.map((s: { service: string }) => [s.service, s]));
    expect(Object.keys(byName).sort()).toEqual(["inventory", "notification", "order", "payment"]);
    expect(byName.payment).toMatchObject({ up: true, status: "ready" });
    expect(byName.payment.groups.map((g: { group: string }) => g.group)).toEqual(["payment"]);
    expect(byName.inventory.routes).toContain("/inventory");
    expect(byName.order.traffic.requests).toBeGreaterThan(0);
    await request(app).get("/admin/services").set((await makeUser()).auth).expect(403);
  });
});

describe("checkout when the inventory service is unavailable", () => {
  it("not running: 503, no order, nothing reserved, cart intact", async () => {
    const u = await makeUser();
    const p = await makeProduct(5);
    await cluster.stop("inventory");
    try {
      const res = await buy(u, p.id, 2);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("inventory_unavailable");
    } finally {
      await cluster.restart("inventory");
    }
    expect(await prisma.order.count({ where: { userId: u.user.id } })).toBe(0);
    expect(await stock(p.id)).toMatchObject({ available: 5, reserved: 0 });
    expect((await request(app).get("/cart").set(u.auth)).body.itemCount).toBe(2);
  });

  it("TIMEOUT (outcome unknown): the order is cancelled and the LATE reservation is refused (tombstone)", async () => {
    // A "slow network" in front of the inventory service: every request arrives 3.5s late - after
    // the order service's 3s timeout. The reservation DOES reach the inventory service, too late.
    const realUrl = serviceUrls.inventory;
    let lateAnswer: Promise<number> | undefined;
    const slow = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const isReserve = req.method === "POST" && req.url === "/internal/reservations";
        const answer = new Promise<number>((resolve) =>
          setTimeout(async () => {
            const r = await fetch(realUrl + req.url, { method: req.method, headers: req.headers as Record<string, string>, body: body || undefined });
            resolve(r.status);
            res.writeHead(r.status).end(await r.text());
          }, isReserve ? 3500 : 0), // only the reservation is slow; the compensating release is fast
        );
        if (isReserve) lateAnswer = answer;
      });
    });
    await new Promise<void>((r) => slow.listen(0, r));
    serviceUrls.inventory = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;

    const u = await makeUser();
    const p = await makeProduct(5);
    let res;
    try {
      res = await buy(u, p.id, 2);
    } finally {
      serviceUrls.inventory = realUrl;
    }
    expect(res.status).toBe(503);
    const order = await prisma.order.findFirstOrThrow({ where: { userId: u.user.id } });
    expect(order).toMatchObject({ status: "CANCELLED", statusReason: "inventory_unavailable", idempotencyKey: null });
    expect((await request(app).get("/cart").set(u.auth)).body.itemCount).toBe(2); // cart restored

    // The late reserve finally arrives at the inventory service... and is refused.
    expect(await lateAnswer).toBe(409);
    expect(await prisma.reservation.findUniqueOrThrow({ where: { orderId: order.id } })).toMatchObject({ status: "RELEASED" });
    expect(await stock(p.id)).toMatchObject({ available: 5, reserved: 0 }); // no stock leaked
    slow.close();
  }, 15_000);
});

describe("reservations are idempotent state transitions", () => {
  const reserve = (orderId: string, productId: string, quantity = 1) =>
    fetch(`${serviceUrls.inventory}/internal/reservations`, {
      method: "POST",
      headers: { ...internal, "content-type": "application/json" },
      body: JSON.stringify({ orderId, items: [{ productId, quantity }] }),
    });
  const release = (orderId: string) => fetch(`${serviceUrls.inventory}/internal/reservations/${orderId}/release`, { method: "POST", headers: internal });

  it("reserve twice = reserve once; release twice = release once", async () => {
    const p = await makeProduct(10);
    const orderId = randomUUID();
    expect((await reserve(orderId, p.id, 3)).status).toBe(201);
    expect((await reserve(orderId, p.id, 3)).status).toBe(200); // "already_reserved"
    expect(await stock(p.id)).toMatchObject({ available: 7, reserved: 3 });
    expect(await (await release(orderId)).json()).toEqual({ status: "released" });
    expect(await (await release(orderId)).json()).toEqual({ status: "already_released" });
    expect(await stock(p.id)).toMatchObject({ available: 10, reserved: 0 });
    await prisma.reservation.delete({ where: { orderId } });
  });

  it("two racing reserves of the same order reserve the stock once", async () => {
    const p = await makeProduct(10);
    const orderId = randomUUID();
    const statuses = (await Promise.all([reserve(orderId, p.id, 4), reserve(orderId, p.id, 4), reserve(orderId, p.id, 4)])).map((r) => r.status);
    expect(statuses.sort()).toEqual([200, 200, 201]);
    expect(await stock(p.id)).toMatchObject({ available: 6, reserved: 4 });
    await release(orderId);
    await prisma.reservation.delete({ where: { orderId } });
  });

  it("release of an unknown order leaves a tombstone that blocks a later reserve", async () => {
    const p = await makeProduct(10);
    const orderId = randomUUID();
    expect(await (await release(orderId)).json()).toEqual({ status: "tombstoned" });
    const late = await reserve(orderId, p.id, 2);
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "reservation_released" });
    expect((await stock(p.id)).available).toBe(10);
    await prisma.reservation.delete({ where: { orderId } });
  });
});

describe("lost and duplicate events", () => {
  it("a lost OrderCreated is re-published by the RECONCILER and the order completes", async () => {
    const u = await makeUser();
    const p = await makeProduct(5);
    await broker.conn.disconnect(); // the broker "is down" at the moment of checkout
    const missed = publisherStats.notPublished;
    let res;
    try {
      res = await buy(u, p.id);
      expect(res.status).toBe(201);
      await expect.poll(() => publisherStats.notPublished).toBe(missed + 1);
    } finally {
      broker.conn.connect(`kv://127.0.0.1:${cluster.logServer!.port}`);
      await broker.conn.waitUntilReady();
    }
    expect((await request(app).get(`/orders/${res.body.id}`).set(u.auth)).body.status).toBe("PENDING");

    // Normally it runs every 10s for orders PENDING > 20s; here we run one sweep "in the future".
    await reconcileOnce(Date.now() + 60_000);
    expect((await settle(app, u.auth, res.body.id)).status).toBe("CONFIRMED");
    await eventually(async () => (await stock(p.id)).reserved === 0);
  }, 20_000);

  it("the same OrderCreated delivered three times charges the card ONCE", async () => {
    const u = await makeUser();
    const p = await makeProduct(5, { priceCents: 1500 });
    const res = await buy(u, p.id);
    const order = await settle(app, u.auth, res.body.id);
    expect(order.status).toBe("CONFIRMED");

    const again = makeEvent<OrderCreated>("OrderCreated", 2, {
      orderId: order.id,
      userId: u.user.id,
      status: "PENDING",
      totalCents: 1500,
      paymentMethod: "TEST_CARD_SUCCESS",
      items: [{ productId: p.id, name: "x", quantity: 1, unitPriceCents: 1500 }],
    });
    await publishEvent(ORDERS_TOPIC, again, "must");
    await publishEvent(ORDERS_TOPIC, again, "must");
    // Let every group catch up, then check: one payment, one notification, stock sold once.
    await eventually(async () => {
      const d = await broker.describe();
      return d.groups.every((g) => g.partitions.every((part) => part.lag === 0));
    });
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { orderId: order.id } })).toBe(1);
    expect(await stock(p.id)).toMatchObject({ available: 4, reserved: 0 });
  });

  it("events carry the checkout's request id across the broker (correlation)", async () => {
    const u = await makeUser();
    const p = await makeProduct(5);
    await request(app).post("/cart/items").set(u.auth).send({ productId: p.id, quantity: 1 });
    const res = await request(app).post("/orders").set(u.auth).set("X-Request-Id", "checkout-trace-42").send({ paymentMethod: "TEST_CARD_SUCCESS" });
    await settle(app, u.auth, res.body.id);
    const headersOf = async (topic: string) => {
      const out: Record<string, string>[] = [];
      for (const part of [0, 1, 2]) {
        const { records } = await broker.fetch(topic, part, 0, 1000);
        out.push(...records.filter((r) => r.key === res.body.id).map((r) => r.headers));
      }
      return out;
    };
    // OrderCreated (order svc) -> PaymentSucceeded (payment svc) -> OrderConfirmed (order svc).
    await eventually(async () => (await headersOf(ORDERS_TOPIC)).length === 2);
    const all = [...(await headersOf(ORDERS_TOPIC)), ...(await headersOf("payments"))];
    expect(all.map((h) => h["x-event-type"]).sort()).toEqual(["OrderConfirmed", "OrderCreated", "PaymentSucceeded"]);
    expect(all.every((h) => h["x-request-id"] === "checkout-trace-42")).toBe(true);
  });
});
