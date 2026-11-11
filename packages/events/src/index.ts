import { createHash } from "node:crypto";

/**
 * THE EVENT CATALOG: every event ScaleCart publishes. An event is a FACT about the past
 * ("OrderConfirmed"), not a command ("SendEmail"): the producer doesn't know or care who listens.
 *
 * M6 flow (choreography - no central coordinator, each service reacts to facts):
 *
 *   order svc   POST /orders: order PENDING, stock reserved (sync HTTP to inventory)
 *        └─► orders:   OrderCreated   (v2, PENDING, carries the payment method)
 *   payment svc ◄─ OrderCreated: charge the card
 *        └─► payments: PaymentSucceeded | PaymentFailed
 *   order svc   ◄─ Payment*: order CONFIRMED | CANCELLED (cart restored)
 *        └─► orders:   OrderConfirmed | OrderCancelled
 *   inventory svc    ◄─ OrderConfirmed: reservation -> sold   |  OrderCancelled: stock released
 *   notification svc ◄─ OrderConfirmed / OrderCancelled: the customer's bell
 *   analytics (order svc) ◄─ OrderConfirmed / OrderCancelled: daily sales projection
 *
 * Key = orderId on BOTH topics: all events of one order are in the same partition, in order.
 */

export const ORDERS_TOPIC = "orders";
export const PAYMENTS_TOPIC = "payments";
export const TOPIC_PARTITIONS = 3;

export interface EventEnvelope<TType extends string, TData> {
  eventId: string; // unique per FACT -> lets consumers detect duplicates
  type: TType;
  version: number; // schema version: consumers can handle old and new shapes during a migration
  occurredAt: string;
  data: TData;
}

export interface OrderLine {
  productId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
}

/**
 * OrderCreated.
 *   v1 (M5, monolith): published AFTER payment, status already CONFIRMED or CANCELLED.
 *   v2 (M6): published when the order is placed, status PENDING, carries paymentMethod.
 * Consumers must still understand v1: old events stay in the log (and can come back via a DLQ
 * replay). This is SCHEMA EVOLUTION - you can never assume every event in a log has the new shape.
 */
export interface OrderCreatedData {
  orderId: string;
  userId: string;
  status: "CONFIRMED" | "CANCELLED" | "PENDING";
  totalCents: number;
  paymentMethod?: string; // v2 only
  items: OrderLine[];
}
export type OrderCreated = EventEnvelope<"OrderCreated", OrderCreatedData>;

export interface OrderSettledData {
  orderId: string;
  userId: string;
  totalCents: number;
  items: OrderLine[];
}
export type OrderConfirmed = EventEnvelope<"OrderConfirmed", OrderSettledData>;
export type OrderCancelled = EventEnvelope<"OrderCancelled", OrderSettledData & { reason: string }>;

export interface PaymentResultData {
  orderId: string;
  paymentId: string;
  amountCents: number;
  providerRef: string;
  reason?: string; // PaymentFailed only, e.g. "card_declined"
}
export type PaymentSucceeded = EventEnvelope<"PaymentSucceeded", PaymentResultData>;
export type PaymentFailed = EventEnvelope<"PaymentFailed", PaymentResultData>;

export type OrderEvent = OrderCreated | OrderConfirmed | OrderCancelled;
export type PaymentEvent = PaymentSucceeded | PaymentFailed;
export type AnyEvent = OrderEvent | PaymentEvent;

/**
 * DETERMINISTIC EVENT IDS. "Order X was confirmed" is ONE fact, however many times we publish it.
 * If the id were random, re-publishing (after a crash, or by the reconciler) would look like a NEW
 * event to the idempotent consumers, and the customer would get two "Order confirmed" messages.
 * Hashing (orderId, type) gives the same UUID-shaped id every time -> duplicates are recognised.
 */
export function deterministicEventId(...parts: string[]) {
  const h = createHash("sha256").update(parts.join("|")).digest("hex");
  // Format as a UUID (version nibble 5 = "name-based", variant 10xx) so it fits the uuid column.
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function makeEvent<E extends AnyEvent>(type: E["type"], version: number, data: E["data"], id?: string): E {
  return {
    eventId: id ?? deterministicEventId(type, (data as { orderId: string }).orderId),
    type,
    version,
    occurredAt: new Date().toISOString(),
    data,
  } as E;
}

