import { broker } from "../config/broker.js";
import { kv } from "../config/kv.js";
import { Consumer } from "../log/consumer.js";
import type { ServiceName } from "../services/registry.js";
import { withRequestId } from "../services/shared/request-context.js";
import { analyticsHandler, notificationHandler } from "./handlers.js";
import { ORDERS_TOPIC, PAYMENTS_TOPIC, TOPIC_PARTITIONS, type AnyEvent, type OrderEvent, type PaymentEvent } from "./order-events.js";

/**
 * EVERY CONSUMER GROUP, which topic it reads, and which SERVICE runs it.
 *
 * In M5 all groups ran inside the one API process. In M6 each service runs only its own groups -
 * `npm run svc:payment` starts the payment service AND its "payment" consumer. Scaling a service =
 * starting more copies of it; the broker spreads the partitions across them (rebalance).
 *
 * The handlers are loaded lazily (import() on first use) so that a service doesn't load the code
 * of the others - and to avoid import cycles (order service <-> event handlers).
 */
type Handler = (event: AnyEvent) => Promise<unknown>;

export const CONSUMER_GROUPS = ["payment", "order", "inventory", "notification", "analytics"] as const;
export type ConsumerGroup = (typeof CONSUMER_GROUPS)[number];

export const GROUPS: Record<ConsumerGroup, { topic: string; service: ServiceName; description: string; handler: () => Promise<Handler> }> = {
  payment: {
    topic: ORDERS_TOPIC,
    service: "payment",
    description: "OrderCreated -> charge the card -> PaymentSucceeded / PaymentFailed",
    handler: async () => (await import("../services/payment/payment.handler.js")).paymentHandler as Handler,
  },
  order: {
    topic: PAYMENTS_TOPIC,
    service: "order",
    description: "Payment result -> order CONFIRMED / CANCELLED -> OrderConfirmed / OrderCancelled",
    handler: async () => (await import("../services/order/payment-results.handler.js")).paymentResultHandler as Handler,
  },
  inventory: {
    topic: ORDERS_TOPIC,
    service: "inventory",
    description: "OrderConfirmed -> stock sold; OrderCancelled -> stock released; low-stock alerts",
    handler: async () => (await import("../services/inventory/inventory.handler.js")).inventoryHandler as Handler,
  },
  notification: {
    topic: ORDERS_TOPIC,
    service: "notification",
    description: "OrderConfirmed / OrderCancelled -> the customer's notification bell",
    handler: async () => notificationHandler as Handler,
  },
  analytics: {
    topic: ORDERS_TOPIC,
    service: "order",
    description: "OrderConfirmed / OrderCancelled -> daily sales projection",
    handler: async () => analyticsHandler as Handler,
  },
};

export const groupsOfService = (service: ServiceName) => CONSUMER_GROUPS.filter((g) => GROUPS[g].service === service);
export const dlqTopicOf = (group: ConsumerGroup) => `${GROUPS[group].topic}.${group}.dlq`;

/**
 * CHAOS SWITCH (admin > Events): makes one consumer group fail on purpose, to watch
 * retry -> DLQ -> replay happen for real. Stored in ScaleKV so every service process sees it.
 */
export const chaosKey = (group: string) => `chaos:fail:${group}`;
async function chaosOn(group: string) {
  if (!kv.isReady) return false;
  return (await kv.get(chaosKey(group)).catch(() => null)) !== null;
}

/** Consumers running in THIS process. */
export const runningConsumers: Consumer[] = [];

export function startWorkers(groups: readonly ConsumerGroup[] = CONSUMER_GROUPS, opts: { log?: boolean } = {}) {
  for (const group of groups) {
    const def = GROUPS[group];
    let handler: Handler | undefined;
    const consumer = new Consumer({
      client: broker,
      group,
      topic: def.topic,
      topicPartitions: TOPIC_PARTITIONS,
      log: opts.log ?? true,
      handle: async (value, meta) => {
        if (await chaosOn(group)) throw new Error(`Simulated failure: chaos switch is ON for "${group}"`);
        handler ??= await def.handler();
        // The request id travelled inside the event headers: logs and onward HTTP calls / events
        // made while handling it carry the SAME id as the click that started it all.
        await withRequestId(meta.headers["x-request-id"], () => handler!(value as OrderEvent | PaymentEvent));
      },
    });
    consumer.start();
    runningConsumers.push(consumer);
  }
  return runningConsumers;
}

export async function stopWorkers() {
  await Promise.all(runningConsumers.splice(0).map((c) => c.stop()));
}
