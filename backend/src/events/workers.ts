import { broker } from "../config/broker.js";
import { kv } from "../config/kv.js";
import { Consumer } from "../log/consumer.js";
import { analyticsHandler, inventoryHandler, notificationHandler } from "./handlers.js";
import { ORDERS_PARTITIONS, ORDERS_TOPIC, type OrderCreated } from "./order-events.js";

export const CONSUMER_GROUPS = ["notification", "inventory", "analytics"] as const;
export type ConsumerGroup = (typeof CONSUMER_GROUPS)[number];

const HANDLERS: Record<ConsumerGroup, (e: OrderCreated) => Promise<unknown>> = {
  notification: notificationHandler,
  inventory: inventoryHandler,
  analytics: analyticsHandler,
};

/**
 * CHAOS SWITCH (admin > Events): makes one consumer group fail on purpose, to watch
 * retry -> DLQ -> replay happen for real. Stored in ScaleKV so every worker process sees it.
 */
export const chaosKey = (group: string) => `chaos:fail:${group}`;
async function chaosOn(group: string) {
  if (!kv.isReady) return false;
  return (await kv.get(chaosKey(group)).catch(() => null)) !== null;
}

/** Consumers running in THIS process (the API, or a `npm run worker` process). */
export const runningConsumers: Consumer[] = [];

export function startWorkers(groups: readonly ConsumerGroup[] = CONSUMER_GROUPS, opts: { log?: boolean } = {}) {
  for (const group of groups) {
    const consumer = new Consumer({
      client: broker,
      group,
      topic: ORDERS_TOPIC,
      topicPartitions: ORDERS_PARTITIONS,
      log: opts.log ?? true,
      handle: async (value) => {
        if (await chaosOn(group)) throw new Error(`Simulated failure: chaos switch is ON for "${group}"`);
        const event = value as OrderCreated;
        if (event.type !== "OrderCreated") return; // unknown event types are ignored, not failed
        await HANDLERS[group](event);
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
