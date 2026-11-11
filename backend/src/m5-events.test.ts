import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "../generated/prisma/client.js";
import { broker } from "@scalecart/service-kit/broker";
import { kv } from "@scalecart/service-kit/kv";
import { prisma } from "./config/prisma.js";
import { once } from "./events/handlers.js";
import { publisherStats } from "@scalecart/service-kit/publisher";
import { startWorkers, stopWorkers } from "./events/workers.js";
import { startKvServer, type RunningKvServer } from "./kv/server.js";
import { startLogServer, type RunningLogServer } from "./log/server.js";
import { settle, startCluster, type Cluster } from "./test-cluster.js";
import { cleanup, makeProduct, makeUser } from "./test-utils.js";

// M5 end-to-end: real checkout -> OrderCreated in a real ScaleLog broker -> the three real
// consumer groups -> rows in PostgreSQL. Plus duplicates, chaos -> DLQ -> replay, broker down.
// M6: the consumer groups now belong to different services, and the order's fate arrives as
// OrderConfirmed / OrderCancelled after the asynchronous payment.

let cluster: Cluster;
let app: Express;
let logServer: RunningLogServer;
let kvServer: RunningKvServer;
let admin: Awaited<ReturnType<typeof makeUser>>;
type U = Awaited<ReturnType<typeof makeUser>>;

const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
let salesBefore: Awaited<ReturnType<typeof sales>>;
// revenueCents is a BigInt column; compare as plain numbers in the tests.
const sales = async () => {
  const row = await prisma.salesDaily.findUnique({ where: { day: today } });
  return row && { ...row, revenueCents: Number(row.revenueCents) };
};
const eventIds: string[] = [];
async function collectEventIds() {
  for (const p of [0, 1, 2]) {
    const { records } = await broker.fetch("orders", p, 0, 500);
    records.forEach((r) => eventIds.push((JSON.parse(r.value) as { eventId: string }).eventId));
  }
}

beforeAll(async () => {
  kvServer = await startKvServer({ port: 0 });
  logServer = await startLogServer({ port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "scalelog-e2e-")) });
  kv.connect(`kv://127.0.0.1:${kvServer.port}`);
  broker.conn.connect(`kv://127.0.0.1:${logServer.port}`);
  await Promise.all([kv.waitUntilReady(), broker.conn.waitUntilReady()]);
  salesBefore = await sales();
  cluster = await startCluster(); // services + gateway; this file manages ScaleKV / ScaleLog itself
  app = cluster.gateway;
  startWorkers(undefined, { log: false });
  admin = await makeUser("ADMIN");
});

afterAll(async () => {
  // try/finally: even if a teardown step fails, the database cleanup below must still run
  // (a failed close once left test users/products behind in the dev database).
  try {
    await stopWorkers();
    await cluster.close();
    // Undo what the consumers wrote outside the test users/products (those cascade in cleanup()).
    if (broker.isReady) await collectEventIds();
    await prisma.processedEvent.deleteMany({ where: { eventId: { in: eventIds } } });
    if (salesBefore) await prisma.salesDaily.update({ where: { day: today }, data: salesBefore });
    else await prisma.salesDaily.deleteMany({ where: { day: today } });
    await Promise.all([kv.disconnect(), broker.conn.disconnect()]);
    await Promise.all([kvServer.close(), logServer.close()]);
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
});

const buy = async (u: U, productId: string, quantity = 1, paymentMethod = "TEST_CARD_SUCCESS") => {
  await request(app).post("/cart/items").set(u.auth).send({ productId, quantity }).expect(201);
  return request(app).post("/orders").set(u.auth).send({ paymentMethod });
};
const notifications = async (u: U) => (await request(app).get("/notifications").set(u.auth)).body as { items: { title: string; body: string; orderId: string }[]; unread: number };
const lag = async (group: string) => {
  const d = await broker.describe();
  return d.groups.find((g) => g.group === group)?.partitions.reduce((s, p) => s + p.lag, 0) ?? -1;
};

describe("an order's events flow through every consumer group", () => {
  it("a confirmed order -> customer notification, analytics projection, low-stock alert", async () => {
    const u = await makeUser();
    const p = await makeProduct(6, { priceCents: 2500 }); // buying 2 leaves 4 <= threshold 5
    const before = (await sales())?.revenueCents ?? 0;
    const res = await buy(u, p.id, 2);
    expect(res.status).toBe(201);

    await expect.poll(async () => (await notifications(u)).items.length, { timeout: 10_000 }).toBe(1);
    const n = await notifications(u);
    expect(n.items[0]).toMatchObject({ title: "Order confirmed", orderId: res.body.id });
    expect(n.unread).toBe(1);
    await expect.poll(async () => (await sales())?.revenueCents ?? 0, { timeout: 10_000 }).toBe(before + 5000);
    await expect.poll(() => prisma.stockAlert.findUnique({ where: { productId: p.id } }), { timeout: 10_000 }).toMatchObject({ available: 4 });

    await request(app).post("/notifications/read-all").set(u.auth).expect(204);
    expect((await notifications(u)).unread).toBe(0);
  });

  it("a declined payment -> 'Payment declined' notification and a cancelled count, no stock alert", async () => {
    const u = await makeUser();
    const p = await makeProduct(2);
    const cancelledBefore = (await sales())?.cancelledOrders ?? 0;
    const res = await buy(u, p.id, 1, "TEST_CARD_DECLINE");
    expect((await settle(app, u.auth, res.body.id)).status).toBe("CANCELLED");
    await expect.poll(async () => (await notifications(u)).items[0]?.title, { timeout: 10_000 }).toBe("Payment declined");
    await expect.poll(async () => (await sales())?.cancelledOrders ?? 0, { timeout: 10_000 }).toBe(cancelledBefore + 1);
    expect(await prisma.stockAlert.findUnique({ where: { productId: p.id } })).toBeNull();
  });
});

describe("delivery guarantees", () => {
  it("the same event delivered twice has its effect only once (idempotent consumers)", async () => {
    const u = await makeUser();
    const p = await makeProduct(50, { priceCents: 1000 });
    const res = await buy(u, p.id);
    await expect.poll(async () => (await notifications(u)).items.length, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => lag("analytics"), { timeout: 10_000 }).toBe(0);
    const revenue = (await sales())!.revenueCents;

    // Find the order's OrderConfirmed record and append it AGAIN - like a redelivery after a crash
    // before commit (or the order service re-publishing it).
    let original: { key: string; value: string } | undefined;
    for (const part of [0, 1, 2]) {
      const { records } = await broker.fetch("orders", part, 0, 500);
      original ??= records.find((r) => r.key === res.body.id && r.value.includes('"type":"OrderConfirmed"'));
    }
    await broker.produce("orders", original!.key, original!.value, { "x-test": "duplicate" });

    for (const g of ["payment", "notification", "inventory", "analytics"]) await expect.poll(() => lag(g), { timeout: 10_000 }).toBe(0);
    expect((await notifications(u)).items).toHaveLength(1); // still one
    expect((await sales())!.revenueCents).toBe(revenue); // not counted twice
  });

  it("chaos: a failing consumer retries, dead-letters, the others carry on, and REPLAY fixes it", async () => {
    await request(app).put("/admin/events/chaos/notification").set(admin.auth).send({ on: true }).expect(200);
    const u = await makeUser();
    const p = await makeProduct(50, { priceCents: 700 });
    const revenueBefore = (await sales())?.revenueCents ?? 0;
    const res = await buy(u, p.id);

    // notification fails 3x per event -> DLQ. Both of the order's events (OrderCreated, then
    // OrderConfirmed) land there. analytics is a different group: unaffected.
    const dlq = async () => (await request(app).get("/admin/events/dlq/notification").set(admin.auth)).body as { waiting: { orderId: string; type: string; error: string; attempts: number }[] };
    await expect.poll(async () => (await dlq()).waiting.length, { timeout: 15_000 }).toBe(2);
    expect((await dlq()).waiting.map((w) => w.type)).toEqual(["OrderCreated", "OrderConfirmed"]);
    expect((await dlq()).waiting[1]).toMatchObject({ orderId: res.body.id, attempts: 3 });
    expect((await dlq()).waiting[0].error).toContain("chaos switch is ON");
    await expect.poll(async () => (await sales())?.revenueCents ?? 0, { timeout: 10_000 }).toBe(revenueBefore + 700);
    expect((await notifications(u)).items).toHaveLength(0);

    // Fix the "bug", replay the DLQ.
    await request(app).put("/admin/events/chaos/notification").set(admin.auth).send({ on: false }).expect(200);
    expect((await request(app).post("/admin/events/dlq/notification/replay").set(admin.auth)).body.replayed).toBe(2);
    await expect.poll(async () => (await notifications(u)).items.length, { timeout: 10_000 }).toBe(1);
    expect((await dlq()).waiting).toHaveLength(0);
    // Replay went through the main topic, so EVERY group saw both events again - and each one
    // recognised them: payment didn't charge twice, analytics didn't count twice.
    for (const g of ["payment", "order", "notification", "inventory", "analytics"]) await expect.poll(() => lag(g), { timeout: 10_000 }).toBe(0);
    expect((await sales())!.revenueCents).toBe(revenueBefore + 700);
  }, 40_000);
});

describe("code-review fixes", () => {
  it("once(): a unique violation inside the WORK is a real failure, not a 'duplicate'", async () => {
    const marker = randomUUID();
    eventIds.push(marker); // cleaned up in afterAll
    const work = (tx: Prisma.TransactionClient) =>
      tx.processedEvent.create({ data: { consumerGroup: "review-test", eventId: marker } }).then(() => undefined);
    const [first, second] = [randomUUID(), randomUUID()];
    eventIds.push(first, second); // every marker this test writes must be cleaned up
    expect(await once("review-test-a", first, work)).toBe("done");
    // Same work again: its OWN insert now conflicts. Must throw (-> retry/DLQ), not report "duplicate".
    await expect(once("review-test-b", second, work)).rejects.toMatchObject({ code: "P2002" });
    // The marker insert failing for any OTHER reason (here: PostgreSQL rejects a malformed uuid)
    // is a real error too - it must never be reported as "already processed".
    await expect(once("review-test-d", "not-a-uuid", async () => undefined)).rejects.toBeDefined();
    // A real redelivery is still recognised as a duplicate.
    const id = randomUUID();
    eventIds.push(id);
    expect(await once("review-test-c", id, async () => undefined)).toBe("done");
    expect(await once("review-test-c", id, async () => undefined)).toBe("duplicate");
  });

  it("an unreadable (non-JSON) DLQ record doesn't hide the queue", async () => {
    const topic = "orders.notification.dlq";
    await broker.createTopic(topic, 1);
    await broker.produce(topic, "k", "this is not json", { "x-error": "cannot parse", "x-attempts": "3" });
    const res = await request(app).get("/admin/events/dlq/notification").set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.waiting.at(-1)).toMatchObject({ type: "unreadable (not JSON)", error: "cannot parse", attempts: 3 });
    // Admin "skip": move the replayer's offset past it instead of replaying garbage.
    const { endOffset } = await broker.fetch(topic, 0, 0, 1);
    await broker.setOffset("replay.notification", topic, 0, endOffset);
    expect((await request(app).get("/admin/events/dlq/notification").set(admin.auth)).body.waiting).toHaveLength(0);
  });

  it("marks only the notifications the user actually saw", async () => {
    const u = await makeUser();
    const [seen, unseen] = await Promise.all(
      ["seen", "arrived later"].map((title) => prisma.notification.create({ data: { userId: u.user.id, title, body: "-" } })),
    );
    const res = await request(app).post("/notifications/read").set(u.auth).send({ ids: [seen.id] });
    expect(res.body.unread).toBe(1);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: unseen.id } })).read).toBe(false);
  });
});

describe("admin view", () => {
  it("shows topics, partitions, consumer groups with lag - to admins only", async () => {
    const res = await request(app).get("/admin/events").set(admin.auth).expect(200);
    expect(res.body.broker.status).toBe("ready");
    expect(res.body.cluster.topics.find((t: { name: string }) => t.name === "orders").partitions).toHaveLength(3);
    const groups = res.body.cluster.groups.map((g: { group: string }) => g.group);
    expect(groups).toEqual(expect.arrayContaining(["payment", "order", "notification", "inventory", "analytics"]));
    expect(res.body.localConsumers).toHaveLength(5); // in tests every group runs in this one process
    expect(res.body.groups.find((g: { group: string }) => g.group === "payment")).toMatchObject({ topic: "orders", service: "payment" });
    await request(app).get("/admin/events").set((await makeUser()).auth).expect(403);
  });
});

// Keep LAST: stops the broker.
describe("when the broker is down", () => {
  it("checkout still answers; the unpublished event is counted and the order waits in PENDING", async () => {
    await collectEventIds(); // for cleanup, while we still can
    await logServer.close();
    await expect.poll(() => broker.conn.status).toBe("down");
    const missedBefore = publisherStats.notPublished;
    const u = await makeUser();
    const res = await buy(u, (await makeProduct(5)).id);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING"); // stock is reserved, but nobody will charge it...
    await expect.poll(() => publisherStats.notPublished).toBe(missedBefore + 1);
    // ...until the broker is back: then the order service's RECONCILER re-publishes it (m6 tests).
  });
});
