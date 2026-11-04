import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../config/prisma.js";
import type { OrderEvent } from "./order-events.js";

/**
 * Consumer handlers that live in more than one service, plus once(). Every consumer group receives
 * EVERY event of its topic independently and keeps its own offsets - a slow or broken analytics
 * consumer never delays notifications.
 */

export const LOW_STOCK_THRESHOLD = 5;

/**
 * IDEMPOTENT CONSUMER: do `work` at most once per (group, event), even if the event is delivered
 * many times. The marker row and the work are written in ONE transaction:
 *   - both commit -> done; a redelivery hits the primary key and is skipped;
 *   - the work throws -> both roll back -> the retry starts clean.
 * This turns at-least-once DELIVERY into exactly-once EFFECT (for effects inside our database).
 */
class AlreadyProcessed extends Error {}

export async function once(group: string, eventId: string, work: (tx: Prisma.TransactionClient) => Promise<void>): Promise<"done" | "duplicate"> {
  try {
    await prisma.$transaction(async (tx) => {
      try {
        await tx.processedEvent.create({ data: { consumerGroup: group, eventId } });
      } catch (e) {
        // ONLY a conflict on the marker itself means "already processed". A unique violation
        // raised by `work` is a real failure and must be retried / dead-lettered, never silently
        // swallowed as a duplicate (found in code review).
        if ((e as { code?: string }).code === "P2002") throw new AlreadyProcessed();
        throw e;
      }
      await work(tx);
    });
    return "done";
  } catch (e) {
    if (e instanceof AlreadyProcessed) return "duplicate";
    throw e;
  }
}


const rupees = (cents: number) =>
  (cents / 100).toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
const shortId = (id: string) => id.slice(0, 8).toUpperCase();

/**
 * Turns any order event into "how did this order END?", or null if it hasn't ended yet.
 *   v2 OrderCreated (PENDING)      -> null: payment hasn't happened, nothing to tell anyone yet
 *   OrderConfirmed / OrderCancelled -> the outcome (M6)
 *   v1 OrderCreated CONFIRMED/CANCELLED -> the outcome (M5 events still in the log, or replayed)
 */
export function outcomeOf(e: OrderEvent): { confirmed: boolean; reason: string | null } | null {
  if (e.type === "OrderConfirmed") return { confirmed: true, reason: null };
  if (e.type === "OrderCancelled") return { confirmed: false, reason: e.data.reason };
  if (e.type === "OrderCreated" && e.data.status !== "PENDING") {
    return { confirmed: e.data.status === "CONFIRMED", reason: e.data.status === "CANCELLED" ? "payment_declined" : null };
  }
  return null;
}

const CANCEL_TEXT: Record<string, string> = {
  payment_declined: "was cancelled because the payment was declined. Your cart is still saved.",
  inventory_unavailable: "could not be completed because our stock system was unavailable. Nothing was charged and your cart is still saved.",
  reservation_released: "was cancelled because the reserved stock was released. Nothing was charged and your cart is still saved.",
  payment_failed: "was cancelled because the payment could not be processed. Nothing was charged and your cart is still saved.",
  out_of_stock:"was cancelled because an item sold out before it could be reserved. Nothing was charged and your cart is still saved.",
};

/** notification service: tell the customer what happened to their order (the bell in the navbar). */
export async function notificationHandler(e: OrderEvent) {
  const outcome = outcomeOf(e);
  if (!outcome) return "skipped";
  const { orderId, userId, totalCents } = e.data;
  const message = outcome.confirmed
    ? { title: "Order confirmed", body: `Your order #${shortId(orderId)} for ${rupees(totalCents)} is confirmed.` }
    : {
        title: outcome.reason === "payment_declined" ? "Payment declined" : "Order cancelled",
        body: `Order #${shortId(orderId)} ${CANCEL_TEXT[outcome.reason ?? ""] ?? "was cancelled."}`,
      };
  return once("notification", e.eventId, async (tx) => {
    await tx.notification.create({ data: { userId, orderId, ...message } });
  });
}

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
