import { randomUUID } from "node:crypto";
import { broker } from "../config/broker.js";
import { brokerErrorCode } from "../log/client.js";

/**
 * The events ScaleCart publishes. An event is a FACT about the past ("OrderCreated"), not a command
 * ("SendEmail"): the producer doesn't know or care who listens. Adding a new consumer later needs
 * no change here - that decoupling is the main reason to use a log like Kafka.
 */

export const ORDERS_TOPIC = "orders";
export const ORDERS_PARTITIONS = 3;

export interface EventEnvelope<T> {
  eventId: string; // unique per event -> lets consumers detect duplicates
  type: string;
  version: number; // schema version: consumers can handle old and new shapes during a migration
  occurredAt: string;
  data: T;
}

export interface OrderCreatedData {
  orderId: string;
  userId: string;
  status: "CONFIRMED" | "CANCELLED" | "PENDING";
  totalCents: number;
  items: { productId: string; name: string; quantity: number; unitPriceCents: number }[];
}
export type OrderCreated = EventEnvelope<OrderCreatedData>;

/** Counters for the admin page. "notPublished" > 0 is the dual-write problem made visible. */
export const publisherStats = { published: 0, notPublished: 0, lastError: null as string | null };

/**
 * Publish AFTER the order transaction committed.
 *
 * KNOWN GAP (on purpose, fixed in M7 with the OUTBOX pattern): this is a "dual write" - the order
 * is in PostgreSQL, the event goes to another system. If the broker is down, or the process dies
 * right here, the order exists but no event is ever published (no notification, no analytics).
 * We never fail the customer's checkout for that; we count it so it is visible.
 */
export async function publishOrderCreated(order: {
  id: string;
  status: OrderCreatedData["status"];
  totalCents: number;
  items: { productId: string; name: string; quantity: number; unitPriceCents: number }[];
}, userId: string): Promise<boolean> {
  const event: OrderCreated = {
    eventId: randomUUID(),
    type: "OrderCreated",
    version: 1,
    occurredAt: new Date().toISOString(),
    data: {
      orderId: order.id,
      userId,
      status: order.status,
      totalCents: order.totalCents,
      items: order.items.map((i) => ({ productId: i.productId, name: i.name, quantity: i.quantity, unitPriceCents: i.unitPriceCents })),
    },
  };
  if (!broker.isReady) {
    publisherStats.notPublished++;
    publisherStats.lastError = "broker not connected";
    return false;
  }
  try {
    // Key = orderId: every event of one order lands in the same partition -> processed in order.
    const headers = { "x-event-type": event.type, "x-event-id": event.eventId };
    try {
      await broker.produce(ORDERS_TOPIC, order.id, JSON.stringify(event), headers);
    } catch (e) {
      if (brokerErrorCode(e) !== "UNKNOWN_TOPIC") throw e;
      await broker.createTopic(ORDERS_TOPIC, ORDERS_PARTITIONS); // first event ever: create the topic
      await broker.produce(ORDERS_TOPIC, order.id, JSON.stringify(event), headers);
    }
    publisherStats.published++;
    return true;
  } catch (e) {
    publisherStats.notPublished++;
    publisherStats.lastError = (e as Error).message;
    console.warn(`[events] OrderCreated for ${order.id} NOT published: ${(e as Error).message}`);
    return false;
  }
}
