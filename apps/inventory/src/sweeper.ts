import { prisma } from "./config/prisma.js";
import { callService, ServiceCallError } from "@scalecart/service-kit/http-client";
import { reservations } from "./reservations.js";

/**
 * THE RESERVATION SWEEPER - the inventory service's own safety net (found in code review).
 *
 * Normally a HELD reservation ends quickly: OrderConfirmed -> commit, OrderCancelled -> release.
 * But if those events are lost (e.g. checkout's reserve call timed out, the direct release failed
 * AND the broker was down for the OrderCancelled), the stock would stay HELD - unsellable - forever.
 *
 * So every 30s: take reservations HELD for longer than 2 minutes and ASK the owner of the truth -
 * the order service - what happened to the order:
 *   CONFIRMED          -> commit (the units are sold)
 *   CANCELLED / absent -> release (the units go back on sale)
 *   PENDING            -> leave it: the order service's reconciler is still working on it
 *   no answer          -> try again next round
 *
 * "Ask the source of truth, then repair" is how distributed systems recover from any lost message.
 * Uses the reservations(status, created_at) index.
 */
export const sweeperSettings = { heldTooLongMs: 2 * 60_000, intervalMs: 30_000, batch: 50 };
export const sweeperStats = { runs: 0, committed: 0, released: 0, lastError: null as string | null };

export async function sweepOnce(now = Date.now()) {
  sweeperStats.runs++;
  const old = await prisma.reservation.findMany({
    where: { status: "HELD", createdAt: { lt: new Date(now - sweeperSettings.heldTooLongMs) } },
    select: { orderId: true },
    orderBy: { createdAt: "asc" },
    take: sweeperSettings.batch,
  });
  for (const { orderId } of old) {
    let status: string;
    try {
      const res = await callService<{ status?: string }>("order", "GET", `/internal/orders/${orderId}/status`, undefined, { timeoutMs: 2000 });
      status = res.status === 404 ? "ABSENT" : (res.body.status ?? "UNKNOWN");
    } catch (e) {
      if (e instanceof ServiceCallError) {
        sweeperStats.lastError = e.message;
        return old.length; // order service unreachable: nothing more to learn this round
      }
      throw e;
    }
    if (status === "CONFIRMED") {
      if ((await reservations.commit(orderId)) === "committed") sweeperStats.committed++;
    } else if (status === "CANCELLED" || status === "ABSENT") {
      if ((await reservations.release(orderId)) === "released") sweeperStats.released++;
    } // PENDING / UNKNOWN: leave it
  }
  return old.length;
}

let timer: NodeJS.Timeout | undefined;
let running = false;

export function startSweeper() {
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepOnce();
    } catch (e) {
      sweeperStats.lastError = (e as Error).message;
    } finally {
      running = false;
    }
  }, sweeperSettings.intervalMs);
  timer.unref();
}

export function stopSweeper() {
  clearInterval(timer);
}
