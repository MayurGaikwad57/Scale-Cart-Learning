import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../config/prisma.js";
import type { OrderCreated } from "./order-events.js";

/**
 * The three consumer groups. Each one receives EVERY OrderCreated event independently and keeps
 * its own offsets - a slow or broken analytics consumer never delays notifications.
 */

export const LOW_STOCK_THRESHOLD = 5;

/**
 * IDEMPOTENT CONSUMER: do `work` at most once per (group, event), even if the event is delivered
 * many times. The marker row and the work are written in ONE transaction:
 *   - both commit -> done; a redelivery hits the primary key and is skipped;
 *   - the work throws -> both roll back -> the retry starts clean.
 * This turns at-least-once DELIVERY into exactly-once EFFECT (for effects inside our database).
 */
export async function once(group: string, eventId: string, work: (tx: Prisma.TransactionClient) => Promise<void>): Promise<"done" | "duplicate"> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.processedEvent.create({ data: { consumerGroup: group, eventId } });
      await work(tx);
    });
    return "done";
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return "duplicate"; // already processed
    throw e;
  }
}

const rupees = (cents: number) =>
  (cents / 100).toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
const shortId = (id: string) => id.slice(0, 8).toUpperCase();

/** notification: tell the customer what happened to their order (the bell in the navbar). */
export async function notificationHandler(e: OrderCreated) {
  const { orderId, userId, status, totalCents } = e.data;
  const message =
    status === "CONFIRMED"
      ? { title: "Order confirmed", body: `Your order #${shortId(orderId)} for ${rupees(totalCents)} is confirmed.` }
      : { title: "Payment declined", body: `Order #${shortId(orderId)} was cancelled because the payment was declined. Your cart is still saved.` };
  return once("notification", e.eventId, async (tx) => {
    await tx.notification.create({ data: { userId, orderId, ...message } });
  });
}

/** inventory: after a sale, flag products that are running low so the admin can restock. */
export async function inventoryHandler(e: OrderCreated) {
  if (e.data.status !== "CONFIRMED") return "skipped";
  const ids = e.data.items.map((i) => i.productId);
  return once("inventory", e.eventId, async (tx) => {
    // Read the CURRENT stock, not the event's numbers: other orders may have happened since.
    const rows = await tx.inventory.findMany({ where: { productId: { in: ids } } });
    for (const r of rows) {
      if (r.available <= LOW_STOCK_THRESHOLD) {
        await tx.stockAlert.upsert({
          where: { productId: r.productId },
          create: { productId: r.productId, available: r.available, lastOrderId: e.data.orderId },
          update: { available: r.available, lastOrderId: e.data.orderId },
        });
      } else {
        await tx.stockAlert.deleteMany({ where: { productId: r.productId } }); // restocked meanwhile
      }
    }
  });
}

/**
 * analytics: a READ MODEL (projection) built only from events - daily orders and revenue.
 * "revenue += total" is NOT naturally idempotent (a duplicate would count twice), which is exactly
 * why it runs inside once().
 */
export async function analyticsHandler(e: OrderCreated) {
  const day = new Date(e.occurredAt.slice(0, 10) + "T00:00:00.000Z"); // UTC calendar day
  const confirmed = e.data.status === "CONFIRMED";
  return once("analytics", e.eventId, async (tx) => {
    await tx.salesDaily.upsert({
      where: { day },
      create: {
        day,
        confirmedOrders: confirmed ? 1 : 0,
        cancelledOrders: confirmed ? 0 : 1,
        revenueCents: confirmed ? e.data.totalCents : 0,
      },
      update: confirmed
        ? { confirmedOrders: { increment: 1 }, revenueCents: { increment: e.data.totalCents } }
        : { cancelledOrders: { increment: 1 } },
    });
  });
}
