import { prisma } from "../../config/prisma.js";
import { ORDERS_TOPIC } from "@scalecart/events";
import { publishEvent } from "../../events/publish.js";
import { orderEvents, ordersService, reserveStock } from "../../modules/orders/orders.service.js";

/**
 * THE RECONCILER - a safety net for orders stuck in PENDING.
 *
 * Checkout publishes OrderCreated AFTER its own transaction committed (a dual write). If the broker
 * was down at that moment, or the process crashed between "order saved" and "event published",
 * nobody would ever charge that order: it would stay PENDING forever, holding reserved stock.
 *
 * So every few seconds we look for orders that have been PENDING "too long" and push them again:
 *   1. reserve the stock again          - idempotent: "already_reserved" if it was done
 *        out of stock / tombstoned -> the order can't go ahead: cancel it (cart restored)
 *        inventory unreachable     -> try again next round
 *   2. re-publish OrderCreated          - the payment service charges at most once per order
 *                                          (it finds its saved payment and re-announces the result)
 *
 * This heals BOTH lost hops: a lost OrderCreated and a lost PaymentSucceeded/Failed.
 * Retries back off (20s, 40s, 80s ... max 5 min) so a payment service that is down for an hour
 * doesn't get the same order re-published every few seconds.
 *
 * In M7 the OUTBOX pattern removes the root cause (event saved in the same transaction as the
 * order). A reconciler stays useful even then: real systems keep "sweepers" for anything stuck.
 * With several order-service instances, each runs a reconciler - harmless here because every step
 * is idempotent (production would add a leader lock so only one instance sweeps).
 */
export const reconcilerSettings = { stuckAfterMs: 20_000, intervalMs: 10_000, maxBackoffMs: 5 * 60_000 };
export const reconcilerStats = { runs: 0, republished: 0, cancelled: 0, lastRunAt: null as string | null, lastError: null as string | null };

const attempts = new Map<string, { count: number; nextAt: number }>();

export async function reconcileOnce(now = Date.now()) {
  reconcilerStats.runs++;
  reconcilerStats.lastRunAt = new Date(now).toISOString();
  // Orders still backing off are excluded IN THE QUERY. Filtering them after "take 50" would let 50
  // permanently failing orders fill every batch, and a newer stuck order would never be looked at
  // (found in code review).
  const backingOff = [...attempts.entries()].filter(([, a]) => a.nextAt > now).map(([id]) => id);
  const stuck = await prisma.order.findMany({
    where: { status: "PENDING", createdAt: { lt: new Date(now - reconcilerSettings.stuckAfterMs) }, id: { notIn: backingOff } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  for (const { id } of stuck) {
    const a = attempts.get(id);
    attempts.set(id, {
      count: (a?.count ?? 0) + 1,
      nextAt: now + Math.min(reconcilerSettings.stuckAfterMs * 2 ** (a?.count ?? 0), reconcilerSettings.maxBackoffMs),
    });

    const order = await ordersService.get(id);
    if (!order || order.status !== "PENDING") continue;
    const reserve = await reserveStock(order.id, order.items);
    if (reserve.outcome === "reserved") {
      if (await publishEvent(ORDERS_TOPIC, orderEvents.created(order, order.userId, order.paymentMethod ?? "unknown"))) reconcilerStats.republished++;
    } else if (reserve.outcome === "insufficient_stock" || reserve.outcome === "released") {
      const reason = reserve.outcome === "released" ? "reservation_released" : "out_of_stock";
      const cancelled = await ordersService.cancel(order.id, reason, "PENDING");
      if (cancelled) {
        reconcilerStats.cancelled++;
        await publishEvent(ORDERS_TOPIC, orderEvents.cancelled(cancelled, order.userId));
      }
    } // unknown / unreachable: next round
  }
  // Forget orders that are no longer PENDING (bounded memory).
  if (attempts.size) {
    const stillPending = await prisma.order.findMany({ where: { id: { in: [...attempts.keys()] }, status: "PENDING" }, select: { id: true } });
    const keep = new Set(stillPending.map((o) => o.id));
    for (const id of [...attempts.keys()]) if (!keep.has(id)) attempts.delete(id);
  }
  return stuck.length;
}

let timer: NodeJS.Timeout | undefined;
let running = false;

export function startReconciler() {
  timer = setInterval(async () => {
    if (running) return; // never overlap two sweeps
    running = true;
    try {
      await reconcileOnce();
    } catch (e) {
      reconcilerStats.lastError = (e as Error).message;
    } finally {
      running = false;
    }
  }, reconcilerSettings.intervalMs);
  timer.unref();
}

export function stopReconciler() {
  clearInterval(timer);
}
