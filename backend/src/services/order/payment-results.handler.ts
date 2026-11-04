import { ORDERS_TOPIC, publishEvent, type PaymentEvent } from "../../events/order-events.js";
import { orderEvents, ordersService } from "../../modules/orders/orders.service.js";

/**
 * Consumer group "order" (runs in the Order Service) on the "payments" topic.
 *
 *   PaymentSucceeded -> order PENDING -> CONFIRMED -> publish OrderConfirmed
 *   PaymentFailed    -> order PENDING -> CANCELLED (cart restored) -> publish OrderCancelled
 *
 * The ORDER service is the only one that changes an order's status: it is the "source of truth"
 * for orders. Payment just reports a fact; inventory and notification react to the order's fate.
 *
 * "Update the row, then publish" is a dual write again. We make it safe like this:
 *   - the status change is conditional ("only if still PENDING") -> doing it twice is harmless;
 *   - the publish is mode "must": if it fails, this handler throws, the offset is NOT committed,
 *     and on redelivery we see the order already settled and simply publish again;
 *   - event ids are deterministic -> downstream consumers recognise the re-published event.
 */
export async function paymentResultHandler(e: PaymentEvent) {
  if (e.type !== "PaymentSucceeded" && e.type !== "PaymentFailed") return "skipped";
  const { orderId } = e.data;

  if (e.type === "PaymentSucceeded") {
    await ordersService.confirm(orderId);
  } else {
    // Keep the real cause: a declined card is the customer's to fix, anything else is not.
    const reason = e.data.reason === undefined || e.data.reason === "card_declined" ? "payment_declined" : "payment_failed";
    await ordersService.cancel(orderId, reason, "FAILED");
  }

  // Publish the order's CURRENT fate - also when another delivery already changed it.
  const order = await ordersService.get(orderId);
  if (!order) return "unknown_order";
  if (order.status === "CONFIRMED") {
    await publishEvent(ORDERS_TOPIC, orderEvents.confirmed(order, order.userId), "must");
  } else if (order.status === "CANCELLED") {
    if (e.type === "PaymentSucceeded") {
      // The card was charged for an order that had already been cancelled (e.g. its stock was
      // released while the payment was in flight). The money must go back: in M7 the SAGA issues a
      // RefundPayment compensation. For now: make it loud.
      console.error(`[order] payment SUCCEEDED for CANCELLED order ${orderId} - refund needed (M7 saga)`);
    }
    await publishEvent(ORDERS_TOPIC, orderEvents.cancelled(order, order.userId), "must");
  }
  return order.status;
}
