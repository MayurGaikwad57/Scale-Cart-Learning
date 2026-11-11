import { deterministicEventId, makeEvent, type ProductCreated } from "@scalecart/events";
import { prisma } from "./config/prisma.js";
import { publishProductEvent } from "./events/publish.js";

/**
 * THE ANNOUNCER (code review of M6.5): a new product only becomes sellable once the inventory
 * service has created its stock row - from our ProductCreated event. Publishing is best effort, so
 * if ScaleLog was down at that moment the event is simply gone, and nothing would ever re-send it.
 *
 * So we RECORD success (products.announced_at) and this job re-publishes every product that hasn't
 * been announced yet. Safe to repeat: the event id is deterministic and the inventory service creates
 * the row only if it is missing. This is the same idea as the order service's reconciler, and a
 * small preview of M7's OUTBOX (which does it for every event).
 */
const INTERVAL_MS = 10_000;

/** Publish ProductCreated for one product and remember it worked. Returns whether it worked. */
export async function announce(p: { id: string; sku: string; name: string; stockAvailable: number }) {
  const ok = await publishProductEvent(
    makeEvent<ProductCreated>("ProductCreated", 1, { productId: p.id, sku: p.sku, name: p.name, initialStock: p.stockAvailable }, deterministicEventId("ProductCreated", p.id)),
  );
  if (ok) await prisma.product.update({ where: { id: p.id }, data: { announcedAt: new Date() } });
  return ok;
}

/** One pass: announce every product that hasn't been announced. Returns how many succeeded. */
export async function announceOnce() {
  const pending = await prisma.product.findMany({ where: { announcedAt: null }, take: 100, orderBy: { createdAt: "asc" } });
  let done = 0;
  for (const p of pending) if (await announce(p)) done++;
  if (done) console.log(`[catalog] announcer: re-published ProductCreated for ${done} product(s)`);
  return done;
}

let timer: NodeJS.Timeout | undefined;
export function startAnnouncer() {
  timer = setInterval(() => void announceOnce().catch((e) => console.warn(`[catalog] announcer: ${(e as Error).message}`)), INTERVAL_MS);
  timer.unref();
}
export function stopAnnouncer() {
  clearInterval(timer);
}
