import { broker } from "./broker.js";
import { kv } from "./kv.js";
import { Consumer } from "./log/consumer.js";
import { withRequestId } from "./request-context.js";

/**
 * The generic EVENT-CONSUMER RUNTIME every service uses. A service describes its consumer groups
 * (which topic, which handler) and the kit runs them: join the group, fetch, retry, DLQ, commit.
 * WHICH groups exist and what they do is the service's business; HOW to run them is shared.
 */
export interface ConsumerDef {
  group: string;
  topic: string;
  partitions: number;
  description?: string;
  /** Loaded lazily on the first event, so a process only loads the code it really needs. */
  handler: () => Promise<(event: unknown) => Promise<unknown>>;
}

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

export function startConsumers(defs: readonly ConsumerDef[], opts: { log?: boolean } = {}) {
  for (const def of defs) {
    let handler: ((event: unknown) => Promise<unknown>) | undefined;
    const consumer = new Consumer({
      client: broker,
      group: def.group,
      topic: def.topic,
      topicPartitions: def.partitions,
      log: opts.log ?? true,
      handle: async (value, meta) => {
        if (await chaosOn(def.group)) throw new Error(`Simulated failure: chaos switch is ON for "${def.group}"`);
        handler ??= await def.handler();
        // The request id travelled inside the event headers: logs and onward HTTP calls / events
        // made while handling it carry the SAME id as the click that started it all.
        await withRequestId(meta.headers["x-request-id"], () => handler!(value));
      },
    });
    consumer.start();
    runningConsumers.push(consumer);
  }
  return runningConsumers;
}

/** Leave every group cleanly: the broker hands our partitions to the other members at once. */
export async function stopConsumers() {
  await Promise.all(runningConsumers.splice(0).map((c) => c.stop()));
}
