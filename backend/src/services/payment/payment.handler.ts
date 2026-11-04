import { makeEvent, PAYMENTS_TOPIC, publishEvent, type OrderEvent, type PaymentFailed, type PaymentSucceeded } from "../../events/order-events.js";
import { failureReason, paymentsService } from "../../modules/payments/payments.service.js";

/**
 * Consumer group "payment" (runs in the Payment Service) on the "orders" topic.
 *
 *   OrderCreated v2 (PENDING) -> charge once -> publish PaymentSucceeded | PaymentFailed
 *
 * WHY ASYNCHRONOUS? Payment is the slowest and least reliable step (an external provider, seconds
 * of latency, outages). In the monolith a slow provider kept the checkout transaction - and its row
 * locks on cart and stock - open the whole time. Now the customer gets an answer immediately
 * ("order placed, payment processing"), and if the payment service is down, orders simply wait in
 * the log until it comes back. Nothing is lost.
 *
 * The publish is mode "must": if it fails we throw, the offset is not committed, the event is
 * redelivered, chargeOnce() finds the saved payment (no second charge) and we publish again.
 */
export async function paymentHandler(e: OrderEvent) {
  // v1 OrderCreated events (M5) were already paid inside the monolith's checkout.
  if (e.type !== "OrderCreated" || e.data.status !== "PENDING") return "skipped";
  const { orderId, totalCents, paymentMethod } = e.data;

  const { payment } = await paymentsService.chargeOnce({ orderId, amountCents: totalCents, method: paymentMethod ?? "unknown" });
  const reason = failureReason(payment.method);
  const data = { orderId, paymentId: payment.id, amountCents: payment.amountCents, providerRef: payment.providerRef ?? "" };

  const result =
    payment.status === "SUCCEEDED"
      ? makeEvent<PaymentSucceeded>("PaymentSucceeded", 1, data)
      : makeEvent<PaymentFailed>("PaymentFailed", 1, { ...data, reason });
  await publishEvent(PAYMENTS_TOPIC, result, "must");
  return payment.status;
}
