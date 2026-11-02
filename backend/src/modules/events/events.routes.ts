import { Router } from "express";
import { z } from "zod";
import { broker } from "../../config/broker.js";
import { kv } from "../../config/kv.js";
import { prisma } from "../../config/prisma.js";
import { publisherStats, ORDERS_TOPIC } from "../../events/order-events.js";
import { chaosKey, CONSUMER_GROUPS, runningConsumers, type ConsumerGroup } from "../../events/workers.js";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { HttpError } from "../../utils/errors.js";

/** Admin > Events: look inside ScaleLog, flip the chaos switch, inspect and replay the DLQ. */
export const eventsRouter = Router();
eventsRouter.use(authenticate, requireRole("ADMIN"));

const unavailable = () => new HttpError(503, "broker_unavailable", "The ScaleLog broker is not connected. Start it with: npm run log");
const groupParam = z.object({ group: z.enum(CONSUMER_GROUPS) });
const dlqTopic = (group: string) => `${ORDERS_TOPIC}.${group}.dlq`;
// The DLQ itself is consumed by a "replayer" group whose committed offset marks "replayed up to here".
const replayGroup = (group: string) => `replay.${group}`;

eventsRouter.get("/", async (_req, res) => {
  const chaos: Record<string, boolean> = {};
  for (const g of CONSUMER_GROUPS) chaos[g] = kv.isReady ? (await kv.get(chaosKey(g)).catch(() => null)) !== null : false;
  res.json({
    broker: { status: broker.conn.status, url: broker.conn.url ?? null },
    cluster: broker.isReady ? await broker.describe().catch(() => null) : null,
    publisher: publisherStats,
    // Consumers running inside THIS API process (a `npm run worker` process has its own).
    localConsumers: runningConsumers.map((c) => ({
      group: c.group,
      memberId: c.memberId,
      generation: c.generation,
      partitions: c.partitions,
      ...c.metrics,
    })),
    chaos,
    chaosAvailable: kv.isReady,
  });
});

eventsRouter.put("/chaos/:group", validateBody(z.object({ on: z.boolean() })), async (req, res) => {
  const { group } = groupParam.parse(req.params);
  if (!kv.isReady) throw new HttpError(503, "kv_unavailable", "The chaos switch is stored in ScaleKV - start it with: npm run kv");
  if (req.body.on) await kv.set(chaosKey(group), "1", { pxMs: 30 * 60_000 }); // auto-off after 30 min
  else await kv.del(chaosKey(group));
  res.json({ group, on: req.body.on });
});

async function dlqState(group: ConsumerGroup) {
  const topic = dlqTopic(group);
  await broker.createTopic(topic, 1);
  const committed = (await broker.committed(replayGroup(group), topic))[0] ?? 0;
  const { records, endOffset } = await broker.fetch(topic, 0, Math.max(0, committed), 100);
  return { topic, committed, endOffset, waiting: records };
}

eventsRouter.get("/dlq/:group", async (req, res) => {
  const { group } = groupParam.parse(req.params);
  if (!broker.isReady) throw unavailable();
  const s = await dlqState(group);
  res.json({
    topic: s.topic,
    total: s.endOffset,
    waiting: s.waiting.map((r) => {
      // The DLQ is exactly where UNREADABLE records end up (a non-JSON "poison" record is
      // dead-lettered on purpose), so one bad record must not hide the whole queue (found in code review).
      let event: { eventId?: string; type?: string; data?: { orderId?: string } } = {};
      try {
        event = JSON.parse(r.value) as typeof event;
      } catch {
        event = { type: "unreadable (not JSON)" };
      }
      return {
        offset: r.offset,
        eventId: event.eventId,
        type: event.type,
        orderId: event.data?.orderId,
        error: r.headers["x-error"],
        attempts: Number(r.headers["x-attempts"] ?? 0),
        failedAt: r.headers["x-failed-at"],
      };
    }),
  });
});

/**
 * REPLAY: put every waiting DLQ event back on the main topic, then move the replayer's offset to
 * the end of the DLQ. All three groups will see these events again - the groups that already
 * processed them skip them (idempotent consumers), only the failed group does the work now.
 */
eventsRouter.post("/dlq/:group/replay", async (req, res) => {
  const { group } = groupParam.parse(req.params);
  if (!broker.isReady) throw unavailable();
  const s = await dlqState(group);
  for (const r of s.waiting) {
    const headers = { ...r.headers, "x-replayed-from": `${s.topic}@${r.offset}` };
    await broker.produce(ORDERS_TOPIC, r.key, r.value, headers);
  }
  const last = s.waiting.at(-1);
  if (last) await broker.setOffset(replayGroup(group), s.topic, 0, last.offset + 1);
  res.json({ replayed: s.waiting.length });
});

/** What the consumers built: the analytics projection and the low-stock alerts. */
eventsRouter.get("/projections", async (_req, res) => {
  const [sales, alerts] = await Promise.all([
    prisma.salesDaily.findMany({ orderBy: { day: "desc" }, take: 14 }),
    prisma.stockAlert.findMany({
      orderBy: { available: "asc" },
      include: { product: { select: { name: true, sku: true } } },
    }),
  ]);
  res.json({
    // revenueCents is a BigInt in the DB; JSON has no BigInt (Number is exact up to 2^53 cents).
    sales: sales.map((s) => ({ ...s, day: s.day.toISOString().slice(0, 10), revenueCents: Number(s.revenueCents) })),
    stockAlerts: alerts.map((a) => ({ productId: a.productId, name: a.product.name, sku: a.product.sku, available: a.available, updatedAt: a.updatedAt })),
  });
});
