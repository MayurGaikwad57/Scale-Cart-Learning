import { createHash, randomUUID } from "node:crypto";
import { broker } from "../config/broker.js";
import { brokerErrorCode } from "../log/client.js";
import { currentRequestId } from "../services/shared/request-context.js";

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
/** @deprecated name kept for M5 code/tests: same as TOPIC_PARTITIONS. */
export const ORDERS_PARTITIONS = TOPIC_PARTITIONS;

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

/** Counters for the admin page. "notPublished" > 0 means a dual write failed (see below). */
export const publisherStats = { published: 0, notPublished: 0, lastError: null as string | null };

/**
 * Publish one event. Creates the topic on first use.
 *
 * DUAL WRITE (still here in M6, fixed properly in M7 with the OUTBOX): the database change and the
 * event are two writes to two systems; either can fail alone. In M6 we limit the damage:
 *   - mode "best-effort" (checkout): never fail the customer's request; count it. The order
 *     service's RECONCILER re-publishes OrderCreated for orders stuck in PENDING.
 *   - mode "must" (inside a consumer): THROW, so the consumer does NOT commit its offset and the
 *     incoming event is retried - the retry re-publishes. Safe because event ids are deterministic.
 */
export async function publishEvent(topic: string, event: AnyEvent, mode: "best-effort" | "must" = "best-effort"): Promise<boolean> {
  const headers: Record<string, string> = { "x-event-type": event.type, "x-event-id": event.eventId };
  const requestId = currentRequestId();
  if (requestId) headers["x-request-id"] = requestId; // correlation survives the hop through the log
  const key = (event.data as { orderId: string }).orderId;
  try {
    if (!broker.isReady) throw new Error("broker not connected");
    try {
      await broker.produce(topic, key, JSON.stringify(event), headers);
    } catch (e) {
      if (brokerErrorCode(e) !== "UNKNOWN_TOPIC") throw e;
      await broker.createTopic(topic, TOPIC_PARTITIONS); // first event ever on this topic
      await broker.produce(topic, key, JSON.stringify(event), headers);
    }
    publisherStats.published++;
    return true;
  } catch (e) {
    publisherStats.notPublished++;
    publisherStats.lastError = (e as Error).message;
    if (mode === "must") throw e;
    console.warn(`[events] ${event.type} for ${key} NOT published: ${(e as Error).message}`);
    return false;
  }
}

/** M5 helper, kept for compatibility: publishes a v1-style OrderCreated with a random id. */
export async function publishOrderCreated(
  order: { id: string; status: OrderCreatedData["status"]; totalCents: number; items: OrderLine[] },
  userId: string,
): Promise<boolean> {
  const event = makeEvent<OrderCreated>(
    "OrderCreated",
    1,
    {
      orderId: order.id,
      userId,
      status: order.status,
      totalCents: order.totalCents,
      items: order.items.map((i) => ({ productId: i.productId, name: i.name, quantity: i.quantity, unitPriceCents: i.unitPriceCents })),
    },
    randomUUID(),
  );
  return publishEvent(ORDERS_TOPIC, event);
}
