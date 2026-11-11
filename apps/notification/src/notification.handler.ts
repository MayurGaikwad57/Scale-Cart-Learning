import { outcomeOf, type OrderEvent } from "@scalecart/events";
import { once } from "./events/once.js";

const rupees = (cents: number) =>
  (cents / 100).toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
const shortId = (id: string) => id.slice(0, 8).toUpperCase();

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
