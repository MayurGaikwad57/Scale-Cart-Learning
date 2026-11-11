import { broker } from "./broker.js";
import { brokerErrorCode } from "./log/client.js";
import { currentRequestId } from "./request-context.js";

/** Counters for the admin page. "notPublished" > 0 means a dual write failed (see below). */
export const publisherStats = { published: 0, notPublished: 0, lastError: null as string | null };

/**
 * Publish one event to ScaleLog. Creates the topic on first use.
 *
 * DUAL WRITE (fixed properly in M7 with the OUTBOX): the database change and the event are two
 * writes to two systems; either can fail alone. Until then we limit the damage:
 *   - mode "best-effort" (inside a user request): never fail the request; count it, return false.
 *   - mode "must" (inside a consumer): THROW, so the consumer does NOT commit its offset and the
 *     incoming event is retried - the retry re-publishes. Safe when event ids are deterministic.
 */
export async function publish(opts: {
  topic: string;
  key: string; // same key -> same partition -> per-key ordering
  partitions: number; // used when the topic has to be created
  event: { eventId: string; type: string };
  mode?: "best-effort" | "must";
}): Promise<boolean> {
  const { topic, key, partitions, event, mode = "best-effort" } = opts;
  const headers: Record<string, string> = { "x-event-type": event.type, "x-event-id": event.eventId };
  const requestId = currentRequestId();
  if (requestId) headers["x-request-id"] = requestId; // correlation survives the hop through the log
  try {
    if (!broker.isReady) throw new Error("broker not connected");
    try {
      await broker.produce(topic, key, JSON.stringify(event), headers);
    } catch (e) {
      if (brokerErrorCode(e) !== "UNKNOWN_TOPIC") throw e;
      await broker.createTopic(topic, partitions); // first event ever on this topic
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
