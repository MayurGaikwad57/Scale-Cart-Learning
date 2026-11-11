import { outcomeOf, type OrderEvent } from "@scalecart/events";
import { once } from "./events/once.js";

/**
 * analytics (runs in the order service): a READ MODEL (projection) built only from events - daily
 * orders and revenue. "revenue += total" is NOT naturally idempotent (a duplicate would count
 * twice), which is exactly why it runs inside once().
 */
export async function analyticsHandler(e: OrderEvent) {
  const outcome = outcomeOf(e);
  if (!outcome) return "skipped";
  const day = new Date(e.occurredAt.slice(0, 10) + "T00:00:00.000Z"); // UTC calendar day
  const { confirmed } = outcome;
  return once("analytics", e.eventId, async (tx) => {
    await tx.salesDaily.upsert({
      where: { day },
      create: {
        day,
        confirmedOrders: confirmed ? 1 : 0,
        cancelledOrders: confirmed ? 0 : 1,
        revenueCents: BigInt(confirmed ? e.data.totalCents : 0),
      },
      update: confirmed
        ? { confirmedOrders: { increment: 1 }, revenueCents: { increment: BigInt(e.data.totalCents) } }
        : { cancelledOrders: { increment: 1 } },
    });
  });
}
