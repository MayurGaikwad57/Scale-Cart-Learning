import { Router } from "express";
import { z } from "zod";
import { broker } from "@scalecart/service-kit/broker";
import { kv } from "@scalecart/service-kit/kv";
import { prisma } from "../../config/prisma.js";
import { publisherStats } from "@scalecart/service-kit/publisher";
import { chaosKey, runningConsumers } from "@scalecart/service-kit/consumers";
import { CONSUMER_GROUPS, dlqTopicOf, GROUPS, type ConsumerGroup } from "../../events/workers.js";
import { authenticate, requireRole } from "@scalecart/service-kit/auth";
import { validateBody } from "@scalecart/service-kit/validate";
import { HttpError } from "@scalecart/service-kit/errors";

/** Admin > Events: look inside ScaleLog, flip the chaos switch, inspect and replay the DLQ. */
export const eventsRouter = Router();
eventsRouter.use(authenticate, requireRole("ADMIN"));

const unavailable = () => new HttpError(503, "broker_unavailable", "The ScaleLog broker is not connected. Start it with: npm run log");
const groupParam = z.object({ group: z.enum(CONSUMER_GROUPS) });
const dlqTopic = dlqTopicOf;
// The DLQ itself is consumed by a "replayer" group whose committed offset marks "replayed up to here".
const replayGroup = (group: string) => `replay.${group}`;

eventsRouter.get("/", async (_req, res) => {
  const chaos: Record<string, boolean> = {};
  for (const g of CONSUMER_GROUPS) chaos[g] = kv.isReady ? (await kv.get(chaosKey(g)).catch(() => null)) !== null : false;
  res.json({
    broker: { status: broker.conn.status, url: broker.conn.url ?? null },
    cluster: broker.isReady ? await broker.describe().catch(() => null) : null,
    publisher: publisherStats,
    // M6: every group, the topic it reads and the SERVICE that runs it (each service runs its own).
    groups: CONSUMER_GROUPS.map((g) => ({ group: g, topic: GROUPS[g].topic, service: GROUPS[g].service, description: GROUPS[g].description })),
    // Consumers running inside THIS process (the order service). Admin > Services shows all of them.
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
 * REPLAY: put every waiting DLQ event back on the group's topic, then move the replayer's offset to
 * the end of the DLQ. Every group of that topic sees these events again - the groups that already
 * processed them skip them (idempotent consumers), only the failed group does the work now.
 */
eventsRouter.post("/dlq/:group/replay", async (req, res) => {
  const { group } = groupParam.parse(req.params);
  if (!broker.isReady) throw unavailable();
  const s = await dlqState(group);
  for (const r of s.waiting) {
    const headers = { ...r.headers, "x-replayed-from": `${s.topic}@${r.offset}` };
    await broker.produce(GROUPS[group].topic, r.key, r.value, headers);
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
