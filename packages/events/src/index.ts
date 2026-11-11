import { createHash, randomUUID } from "node:crypto";

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
export const INVENTORY_TOPIC = "inventory";
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

/**
 * StockChanged (M6.5): the inventory service changed how much of some products can be sold.
 * Published on the "inventory" topic, key = productId. Whoever shows stock (the product pages,
 * owned by the order service today, by the catalog service later) refreshes its own copy / cache.
 * Before M6.5 the inventory service reached into the order service's cache code instead - a
 * service must never import another service's code.
 */
export interface StockChangedData {
  productId: string;
  /** reservation = an order reserved/released stock; admin = an admin set the stock level. */
  cause: "reservation" | "admin";
}
export type StockChanged = EventEnvelope<"StockChanged", StockChangedData>;

export type OrderEvent = OrderCreated | OrderConfirmed | OrderCancelled;
export type PaymentEvent = PaymentSucceeded | PaymentFailed;
export type InventoryEvent = StockChanged;
export type AnyEvent = OrderEvent | PaymentEvent | InventoryEvent;

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
    eventId: id ?? deterministicEventId(type, (data as { orderId?: string }).orderId ?? randomUUID()),
    type,
    version,
    occurredAt: new Date().toISOString(),
    data,
  } as E;
}


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

/**
 * THE CONSUMER-GROUP DIRECTORY: who listens to which topic, and which service runs the group.
 * Part of the contract (like an AsyncAPI document): the admin pages show it, and every service
 * wires ITS OWN groups to ITS OWN handlers. The handler code itself lives in the owning service.
 */
export const SERVICES = ["order", "payment", "inventory", "notification"] as const;
export type Service = (typeof SERVICES)[number];

export const CONSUMER_GROUPS = ["payment", "order", "inventory", "notification", "analytics", "product_cache"] as const;
export type ConsumerGroup = (typeof CONSUMER_GROUPS)[number];

export const GROUPS: Record<ConsumerGroup, { topic: string; service: Service; description: string }> = {
  payment: { topic: ORDERS_TOPIC, service: "payment", description: "OrderCreated -> charge the card -> PaymentSucceeded / PaymentFailed" },
  order: { topic: PAYMENTS_TOPIC, service: "order", description: "Payment result -> order CONFIRMED / CANCELLED -> OrderConfirmed / OrderCancelled" },
  inventory: { topic: ORDERS_TOPIC, service: "inventory", description: "OrderConfirmed -> stock sold; OrderCancelled -> stock released; low-stock alerts" },
  notification: { topic: ORDERS_TOPIC, service: "notification", description: "OrderConfirmed / OrderCancelled -> the customer's notification bell" },
  analytics: { topic: ORDERS_TOPIC, service: "order", description: "OrderConfirmed / OrderCancelled -> daily sales projection" },
  "product_cache": { topic: INVENTORY_TOPIC, service: "order", description: "StockChanged -> refresh the cached product pages that show stock" },
};

export const groupsOfService = (service: Service) => CONSUMER_GROUPS.filter((g) => GROUPS[g].service === service);
export const dlqTopicOf = (group: ConsumerGroup) => `${GROUPS[group].topic}.${group}.dlq`;

/** Build a consumer definition (the shape the service-kit's consumer runtime takes) from the directory. */
export const consumerDef = (group: ConsumerGroup, handler: () => Promise<(event: never) => Promise<unknown>>) => ({
  group,
  topic: GROUPS[group].topic,
  partitions: TOPIC_PARTITIONS,
  description: GROUPS[group].description,
  handler: handler as () => Promise<(event: unknown) => Promise<unknown>>,
});

/** The payment methods the payment service understands - the order service accepts only these. */
export const PAYMENT_METHODS = ["TEST_CARD_SUCCESS", "TEST_CARD_DECLINE"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
