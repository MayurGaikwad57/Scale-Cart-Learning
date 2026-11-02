import { KvClient, KvCommandError } from "../kv/client.js";
import type { LogRecord } from "./storage.js";

export type { LogRecord };

export interface Assignment {
  generation: number;
  partitions: number[];
  members: number;
}

export interface BrokerDescription {
  topics: { name: string; partitions: { partition: number; endOffset: number }[] }[];
  groups: {
    group: string;
    topic: string;
    generation: number;
    members: { id: string; partitions: number[]; lastSeenMsAgo: number }[];
    partitions: { partition: number; committed: number; endOffset: number; lag: number }[];
  }[];
  stats: { produced: number; fetchedRecords: number; commits: number; rebalances: number };
}

/** The broker's error code, e.g. "ILLEGAL_GENERATION" from "ILLEGAL_GENERATION generation 3 is stale". */
export const brokerErrorCode = (e: unknown) => (e instanceof KvCommandError ? e.message.split(" ")[0] : null);

/**
 * Typed client for the ScaleLog broker. The transport is the same pipelined RESP connection we
 * built for ScaleKV (KvClient): reconnect, timeouts, fail-fast and circuit breaker come for free.
 */
export class LogClient {
  constructor(readonly conn: KvClient) {}

  get isReady() {
    return this.conn.isReady;
  }

  private async json<T>(...args: (string | number)[]): Promise<T> {
    return JSON.parse((await this.conn.command(...args)) as string) as T;
  }

  async createTopic(topic: string, partitions: number): Promise<number> {
    return (await this.conn.command("CREATETOPIC", topic, partitions)) as number;
  }

  async produce(topic: string, key: string, value: string, headers: Record<string, string> = {}) {
    const [partition, offset] = (await this.conn.command("PRODUCE", topic, key, value, JSON.stringify(headers))) as number[];
    return { partition, offset };
  }

  fetch(topic: string, partition: number, offset: number, max: number) {
    return this.json<{ records: LogRecord[]; endOffset: number }>("FETCH", topic, partition, offset, max);
  }

  join(group: string, topic: string, memberId: string) {
    return this.json<Assignment>("JOIN", group, topic, memberId);
  }

  heartbeat(group: string, memberId: string) {
    return this.json<Assignment>("HEARTBEAT", group, memberId);
  }

  async leave(group: string, memberId: string) {
    await this.conn.command("LEAVE", group, memberId);
  }

  async commit(group: string, topic: string, partition: number, offset: number, memberId: string, generation: number) {
    await this.conn.command("COMMIT", group, topic, partition, offset, memberId, generation);
  }

  committed(group: string, topic: string) {
    return this.json<Record<string, number | null>>("COMMITTED", group, topic);
  }

  async setOffset(group: string, topic: string, partition: number, offset: number) {
    await this.conn.command("SETOFFSET", group, topic, partition, offset);
  }

  describe() {
    return this.json<BrokerDescription>("DESCRIBE");
  }
}
