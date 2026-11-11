import { ORDERS_TOPIC, PAYMENTS_TOPIC, TOPIC_PARTITIONS, type AnyEvent } from "@scalecart/events";
import { startConsumers, stopConsumers, type ConsumerDef } from "@scalecart/service-kit/consumers";
import type { ServiceName } from "@scalecart/service-kit/registry";
import { analyticsHandler, notificationHandler } from "./handlers.js";

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

/** The groups as the kit's consumer runtime wants them. */
export const consumersOf = (groups: readonly ConsumerGroup[]): ConsumerDef[] =>
  groups.map((group) => ({
    group,
    topic: GROUPS[group].topic,
    partitions: TOPIC_PARTITIONS,
    description: GROUPS[group].description,
    handler: GROUPS[group].handler as ConsumerDef["handler"],
  }));

/** Start the given groups in THIS process (a service starts its own; tests and `npm run worker` pick). */
export const startWorkers = (groups: readonly ConsumerGroup[] = CONSUMER_GROUPS, opts: { log?: boolean } = {}) =>
  startConsumers(consumersOf(groups), opts);

export const stopWorkers = stopConsumers;
