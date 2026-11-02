import { randomUUID } from "node:crypto";
import os from "node:os";
import { brokerErrorCode, type Assignment, type LogClient, type LogRecord } from "./client.js";

/**
 * A consumer-group member: the runtime that turns "events in a log" into "work done once".
 *
 *   join group ──► get partitions ──► for each partition:
 *        fetch from my position ──► handle(event) ──► COMMIT offset+1 ──► next
 *                                     │ fails?
 *                                     ├─ retry with backoff (200ms, 400ms ...) up to maxAttempts
 *                                     └─ still failing: copy it to the DLQ topic, commit, move on
 *   heartbeat every second ──► learn about rebalances (new generation / other partitions)
 *
 * DELIVERY GUARANTEE = AT-LEAST-ONCE: we commit AFTER handling. If we crash between "handled" and
 * "committed", the event is delivered again after restart. (Commit BEFORE handling would be
 * at-most-once: a crash loses the event.) So handlers must be IDEMPOTENT - see events/idempotent.ts.
 *
 * ORDERING: one partition is processed strictly sequentially, and all events with the same key
 * are in the same partition -> per-key order is preserved. A poison event goes to the DLQ instead
 * of blocking its partition forever (head-of-line blocking) - the trade-off is that later events of
 * the same key may then be processed before the failed one is replayed.
 */

export interface EventMeta {
  topic: string;
  partition: number;
  offset: number;
  key: string;
  headers: Record<string, string>;
  attempt: number;
}

export interface ConsumerOptions {
  client: LogClient;
  group: string;
  topic: string;
  /** Partitions to create the topic with if it doesn't exist yet. */
  topicPartitions?: number;
  handle: (value: unknown, meta: EventMeta) => Promise<void>;
  maxAttempts?: number;
  backoffMs?: (attempt: number) => number;
  dlqTopic?: string;
  pollIdleMs?: number;
  heartbeatMs?: number;
  batchSize?: number;
  log?: boolean;
}

export interface ConsumerMetrics {
  processed: number;
  retries: number;
  deadLettered: number;
  rebalances: number;
  lastError: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Errors meaning "you no longer own this partition" (we were fenced during a rebalance).
const FENCED = new Set(["ILLEGAL_GENERATION", "NOT_ASSIGNED", "UNKNOWN_MEMBER"]);

export class Consumer {
  readonly memberId: string;
  readonly dlqTopic: string;
  generation = -1;
  partitions: number[] = [];
  readonly metrics: ConsumerMetrics = { processed: 0, retries: 0, deadLettered: 0, rebalances: 0, lastError: null };

  private readonly positions = new Map<number, number>(); // partition -> next offset to process
  private joined = false;
  private running = false;
  private loopDone: Promise<void> = Promise.resolve();
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private readonly o: Required<Omit<ConsumerOptions, "dlqTopic" | "topicPartitions">> & { topicPartitions?: number };

  constructor(opts: ConsumerOptions) {
    this.o = {
      maxAttempts: 3,
      backoffMs: (attempt) => 200 * 2 ** (attempt - 1),
      pollIdleMs: 300,
      heartbeatMs: 1000,
      batchSize: 50,
      log: true,
      ...opts,
    };
    this.dlqTopic = opts.dlqTopic ?? `${opts.topic}.${opts.group}.dlq`;
    // Unique per process instance, so two workers on one machine are two different members.
    this.memberId = `${opts.group}-${os.hostname()}-${process.pid}-${randomUUID().slice(0, 6)}`;
  }

  get group() {
    return this.o.group;
  }
  get topic() {
    return this.o.topic;
  }
  get isRunning() {
    return this.running;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.o.heartbeatMs);
    this.heartbeatTimer.unref();
    this.loopDone = this.loop();
  }

  /** Graceful stop: finish the current event, then LEAVE so the group rebalances immediately. */
  async stop() {
    this.running = false;
    clearInterval(this.heartbeatTimer);
    await this.loopDone;
    if (this.joined) await this.o.client.leave(this.o.group, this.memberId).catch(() => undefined);
    this.joined = false;
  }

  /** Simulates a crash for tests/demos: stop WITHOUT leaving - the broker notices via missing heartbeats. */
  async kill() {
    this.running = false;
    clearInterval(this.heartbeatTimer);
    await this.loopDone;
    this.joined = false;
  }

  private say(msg: string) {
    if (this.o.log) console.log(`[consumer ${this.o.group}] ${msg}`);
  }

  private apply(a: Assignment) {
    if (a.generation === this.generation) return;
    const kept = new Set(a.partitions);
    // Forget positions of partitions we lost; for those we keep, the committed offset is re-read
    // (another member may have processed them while we didn't own them).
    this.positions.clear();
    this.generation = a.generation;
    this.partitions = a.partitions;
    this.metrics.rebalances++;
    this.say(`generation ${a.generation}: partitions [${[...kept].join(", ")}] (${a.members} member(s) in group)`);
  }

  private async heartbeat() {
    if (!this.joined || !this.running) return;
    try {
      this.apply(await this.o.client.heartbeat(this.o.group, this.memberId));
    } catch (e) {
      if (brokerErrorCode(e) === "UNKNOWN_MEMBER") this.joined = false; // session expired -> rejoin
    }
  }

  private async loop() {
    while (this.running) {
      try {
        if (!this.joined) {
          if (this.o.topicPartitions) await this.o.client.createTopic(this.o.topic, this.o.topicPartitions);
          await this.o.client.createTopic(this.dlqTopic, 1);
          this.apply(await this.o.client.join(this.o.group, this.o.topic, this.memberId));
          this.joined = true;
        }
        let worked = false;
        for (const p of [...this.partitions]) {
          if (!this.running) break;
          if (await this.pollPartition(p)) worked = true;
        }
        if (!worked) await sleep(this.o.pollIdleMs);
      } catch (e) {
        // Broker down or timing out: keep trying, slowly. Nothing is lost - the events stay in
        // the log and our committed offset says where to continue.
        this.metrics.lastError = (e as Error).message;
        if (brokerErrorCode(e) === "UNKNOWN_MEMBER") this.joined = false;
        if (!this.o.client.isReady) this.joined = false;
        await sleep(1000);
      }
    }
  }

  private async pollPartition(p: number): Promise<boolean> {
    const gen = this.generation;
    if (!this.positions.has(p)) {
      const committed = await this.o.client.committed(this.o.group, this.o.topic);
      // No commit yet -> start from the beginning ("auto.offset.reset = earliest").
      this.positions.set(p, committed[p] ?? 0);
    }
    const { records } = await this.o.client.fetch(this.o.topic, p, this.positions.get(p)!, this.o.batchSize);
    for (const rec of records) {
      // A rebalance happened while we were working: stop, the partition may belong to someone else now.
      if (!this.running || gen !== this.generation || !this.partitions.includes(p)) return true;
      await this.processWithRetry(rec, p);
      try {
        await this.o.client.commit(this.o.group, this.o.topic, p, rec.offset + 1, this.memberId, gen);
      } catch (e) {
        if (FENCED.has(brokerErrorCode(e) ?? "")) {
          // We were fenced: the new owner will process this event again (that's the duplicate
          // that at-least-once delivery warns about - handlers are idempotent).
          this.positions.delete(p);
          return true;
        }
        throw e;
      }
      this.positions.set(p, rec.offset + 1);
      this.metrics.processed++;
    }
    return records.length > 0;
  }

  private async processWithRetry(rec: LogRecord, partition: number) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.o.maxAttempts; attempt++) {
      try {
        const meta: EventMeta = { topic: this.o.topic, partition, offset: rec.offset, key: rec.key, headers: rec.headers, attempt };
        await this.o.handle(JSON.parse(rec.value) as unknown, meta); // a non-JSON "poison" record fails here too
        return;
      } catch (e) {
        lastError = e;
        this.metrics.lastError = (e as Error).message;
        if (attempt < this.o.maxAttempts) {
          this.metrics.retries++;
          await sleep(this.o.backoffMs(attempt)); // exponential backoff: give a struggling dependency room
        }
      }
    }
    // Give up on this event: park it in the DEAD LETTER QUEUE with the reason, so the partition
    // keeps flowing. If even the DLQ write fails, this throws and we do NOT commit -> retried later.
    await this.o.client.produce(this.dlqTopic, rec.key, rec.value, {
      ...rec.headers,
      "x-error": String((lastError as Error)?.message ?? lastError),
      "x-attempts": String(this.o.maxAttempts),
      "x-original-topic": this.o.topic,
      "x-original-partition": String(partition),
      "x-original-offset": String(rec.offset),
      "x-consumer-group": this.o.group,
      "x-failed-at": new Date().toISOString(),
    });
    this.metrics.deadLettered++;
    this.say(`offset ${partition}/${rec.offset} failed ${this.o.maxAttempts}x -> moved to ${this.dlqTopic}`);
  }
}
