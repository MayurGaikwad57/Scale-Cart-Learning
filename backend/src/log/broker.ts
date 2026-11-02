import fs from "node:fs";
import path from "node:path";
import { OK, RespError, SimpleString, type Reply } from "../kv/resp.js";
import { PartitionLog } from "./storage.js";

/**
 * ScaleLog broker - our own small Kafka. The engine behind `npm run log`.
 *
 * Concepts, and where they live in this file:
 *  TOPIC            a named stream of events, split into PARTITIONS (each a PartitionLog file).
 *  PRODUCE          append to one partition. Same key -> same partition (hash), so all events of
 *                   one order are stored - and later processed - in order.
 *  CONSUMER GROUP   a set of consumer processes sharing the work for one topic. Every partition
 *                   is assigned to exactly ONE member of the group. Different groups each get
 *                   ALL events (that's how notification, inventory and analytics all see every order).
 *  REBALANCING      when a member joins, leaves or stops sending heartbeats, partitions are
 *                   re-divided and the group's GENERATION number goes up.
 *  COMMITTED OFFSET "group G has processed partition P up to (not including) offset N". Stored in
 *                   the internal topic __consumer_offsets - an append-only log, exactly like Kafka.
 *  FENCING          a commit carries the member's generation; a commit from an old generation
 *                   (a "zombie" that lost its partition during a rebalance) is rejected.
 *
 * Simplifications vs Kafka: one broker (no replication / leader election), the broker computes
 * the partition assignment (Kafka lets the group leader do it), and one topic per group.
 */

export const OFFSETS_TOPIC = "__consumer_offsets";
const TOPIC_NAME = /^[A-Za-z0-9._]{1,100}$/; // no "-": file names are "<topic>-<partition>.log"
const MAX_FETCH = 500;

export interface BrokerOptions {
  dataDir: string;
  /** A member that sends no heartbeat for this long is considered dead and removed. */
  sessionTimeoutMs?: number;
  now?: () => number;
}

interface Member {
  id: string;
  lastSeen: number;
  partitions: number[];
}
interface Group {
  id: string;
  topic: string;
  generation: number;
  members: Map<string, Member>;
}

const err = (code: string, msg: string) => new RespError(`${code} ${msg}`);
const json = (v: unknown) => JSON.stringify(v);

/** FNV-1a: a tiny, fast, stable string hash. Stable matters: the same key must always map to the same partition. */
export function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Broker {
  private readonly topics = new Map<string, PartitionLog[]>();
  private readonly groups = new Map<string, Group>();
  private readonly commits = new Map<string, number>(); // "group|topic|partition" -> next offset to process
  private readonly sessionTimeoutMs: number;
  private readonly now: () => number;
  private roundRobin = 0;
  readonly stats = { produced: 0, fetchedRecords: 0, commits: 0, rebalances: 0 };

  constructor(private readonly opts: BrokerOptions) {
    this.sessionTimeoutMs = opts.sessionTimeoutMs ?? 10_000;
    this.now = opts.now ?? Date.now;
    fs.mkdirSync(opts.dataDir, { recursive: true });
    this.loadTopics();
    this.createTopic(OFFSETS_TOPIC, 1);
    // Rebuild committed offsets by replaying __consumer_offsets: the last commit per partition wins.
    const log = this.topics.get(OFFSETS_TOPIC)![0];
    for (const rec of log.read(0, log.endOffset)) {
      const c = JSON.parse(rec.value) as { group: string; topic: string; partition: number; offset: number };
      this.commits.set(`${c.group}|${c.topic}|${c.partition}`, c.offset);
    }
  }

  private loadTopics() {
    const partitions = new Map<string, number>();
    for (const f of fs.readdirSync(this.opts.dataDir)) {
      const m = /^(.+)-(\d+)\.log$/.exec(f);
      if (m) partitions.set(m[1], Math.max(partitions.get(m[1]) ?? 0, Number(m[2]) + 1));
    }
    for (const [topic, count] of partitions) this.openTopic(topic, count);
  }

  private openTopic(topic: string, count: number) {
    const logs = Array.from({ length: count }, (_, p) => new PartitionLog(path.join(this.opts.dataDir, `${topic}-${p}.log`)));
    this.topics.set(topic, logs);
    return logs;
  }

  close() {
    for (const logs of this.topics.values()) logs.forEach((l) => l.close());
  }

  // ------------------------------------------------------------------ topics & records

  /** Idempotent: creating an existing topic returns its partition count unchanged. */
  createTopic(topic: string, partitions: number): number {
    const existing = this.topics.get(topic);
    if (existing) return existing.length;
    return this.openTopic(topic, partitions).length;
  }

  produce(topic: string, key: string, value: string, headers: Record<string, string> = {}): [number, number] | RespError {
    const logs = this.topics.get(topic);
    if (!logs) return err("UNKNOWN_TOPIC", `topic '${topic}' does not exist`);
    // Keyed records go to hash(key) % partitions -> per-key ORDER is preserved.
    // Records without a key are spread round-robin (no ordering promise at all).
    const partition = key ? hashKey(key) % logs.length : this.roundRobin++ % logs.length;
    const rec = logs[partition].append({ key, value, headers });
    this.stats.produced++;
    return [partition, rec.offset];
  }

  fetch(topic: string, partition: number, offset: number, max: number): Reply {
    const log = this.topics.get(topic)?.[partition];
    if (!log) return err("UNKNOWN_PARTITION", `${topic}/${partition}`);
    if (offset < 0 || offset > log.endOffset) return err("OFFSET_OUT_OF_RANGE", `offset ${offset}, log end ${log.endOffset}`);
    const records = log.read(offset, Math.min(max, MAX_FETCH));
    this.stats.fetchedRecords += records.length;
    return json({ records, endOffset: log.endOffset });
  }

  // ------------------------------------------------------------------ consumer groups

  /** Remove members whose heartbeats stopped (crashed / frozen / network cut) -> rebalance. */
  tick() {
    const deadline = this.now() - this.sessionTimeoutMs;
    for (const g of this.groups.values()) {
      let removed = false;
      for (const m of g.members.values()) {
        if (m.lastSeen < deadline) {
          g.members.delete(m.id);
          removed = true;
        }
      }
      if (removed) this.rebalance(g);
    }
  }

  /**
   * RANGE assignment: sort members, give each a contiguous block of partitions.
   * 3 partitions, 2 members -> A: [0,1], B: [2]. More members than partitions -> some get none
   * (that's why the partition count caps a group's parallelism).
   */
  private rebalance(g: Group) {
    g.generation++;
    this.stats.rebalances++;
    const count = this.topics.get(g.topic)?.length ?? 0;
    const members = [...g.members.values()].sort((a, b) => a.id.localeCompare(b.id));
    const per = members.length ? Math.floor(count / members.length) : 0;
    const extra = members.length ? count % members.length : 0;
    let next = 0;
    members.forEach((m, i) => {
      const n = per + (i < extra ? 1 : 0);
      m.partitions = Array.from({ length: n }, (_, k) => next + k);
      next += n;
    });
  }

  private assignment(g: Group, m: Member) {
    return json({ generation: g.generation, partitions: m.partitions, members: g.members.size });
  }

  join(groupId: string, topic: string, memberId: string): Reply {
    if (!this.topics.has(topic)) return err("UNKNOWN_TOPIC", `topic '${topic}' does not exist`);
    this.tick();
    let g = this.groups.get(groupId);
    if (!g) {
      g = { id: groupId, topic, generation: 0, members: new Map() };
      this.groups.set(groupId, g);
    }
    if (g.topic !== topic) return err("GROUP_TOPIC_MISMATCH", `group '${groupId}' consumes '${g.topic}'`);
    let m = g.members.get(memberId);
    if (!m) {
      m = { id: memberId, lastSeen: this.now(), partitions: [] };
      g.members.set(memberId, m);
      this.rebalance(g);
    }
    m.lastSeen = this.now();
    return this.assignment(g, m);
  }

  heartbeat(groupId: string, memberId: string): Reply {
    this.tick();
    const g = this.groups.get(groupId);
    const m = g?.members.get(memberId);
    if (!g || !m) return err("UNKNOWN_MEMBER", "not a member (session expired?) - join again");
    m.lastSeen = this.now();
    return this.assignment(g, m);
  }

  leave(groupId: string, memberId: string): Reply {
    const g = this.groups.get(groupId);
    if (g?.members.delete(memberId)) this.rebalance(g);
    return OK;
  }

  private storeCommit(group: string, topic: string, partition: number, offset: number) {
    this.commits.set(`${group}|${topic}|${partition}`, offset);
    this.topics.get(OFFSETS_TOPIC)![0].append({
      key: `${group}|${topic}|${partition}`,
      value: json({ group, topic, partition, offset }),
      headers: {},
    });
    this.stats.commits++;
  }

  commit(groupId: string, topic: string, partition: number, offset: number, memberId: string, generation: number): Reply {
    const g = this.groups.get(groupId);
    const m = g?.members.get(memberId);
    if (!g || !m) return err("UNKNOWN_MEMBER", "not a member - join again");
    // FENCING: after a rebalance the old owner of a partition must not overwrite the new owner's progress.
    if (generation !== g.generation) return err("ILLEGAL_GENERATION", `generation ${generation} is stale (now ${g.generation})`);
    if (!m.partitions.includes(partition)) return err("NOT_ASSIGNED", `partition ${partition} is not assigned to you`);
    const end = this.topics.get(topic)?.[partition]?.endOffset;
    if (end === undefined || offset < 0 || offset > end) return err("OFFSET_OUT_OF_RANGE", `offset ${offset}`);
    this.storeCommit(groupId, topic, partition, offset);
    return OK;
  }

  committed(groupId: string, topic: string): Reply {
    const count = this.topics.get(topic)?.length ?? 0;
    const out: Record<number, number | null> = {};
    for (let p = 0; p < count; p++) out[p] = this.commits.get(`${groupId}|${topic}|${p}`) ?? null;
    return json(out);
  }

  /** Admin "reset offsets" (like kafka-consumer-groups --reset-offsets). Only for an idle group. */
  setOffset(groupId: string, topic: string, partition: number, offset: number): Reply {
    if ((this.groups.get(groupId)?.members.size ?? 0) > 0) return err("GROUP_ACTIVE", "stop the group's consumers first");
    const end = this.topics.get(topic)?.[partition]?.endOffset;
    if (end === undefined || offset < 0 || offset > end) return err("OFFSET_OUT_OF_RANGE", `offset ${offset}`);
    this.storeCommit(groupId, topic, partition, offset);
    return OK;
  }

  describe(): Reply {
    this.tick();
    const topics = [...this.topics.entries()]
      .filter(([name]) => name !== OFFSETS_TOPIC)
      .map(([name, logs]) => ({ name, partitions: logs.map((l, p) => ({ partition: p, endOffset: l.endOffset })) }));

    // Groups = active ones + those only known from committed offsets (e.g. after a broker restart).
    const pairs = new Map<string, string>();
    for (const g of this.groups.values()) pairs.set(g.id, g.topic);
    for (const k of this.commits.keys()) {
      const [group, topic] = k.split("|");
      if (!pairs.has(group)) pairs.set(group, topic);
    }
    const now = this.now();
    const groups = [...pairs.entries()].map(([group, topic]) => {
      const g = this.groups.get(group);
      const logs = this.topics.get(topic) ?? [];
      return {
        group,
        topic,
        generation: g?.generation ?? 0,
        members: [...(g?.members.values() ?? [])].map((m) => ({ id: m.id, partitions: m.partitions, lastSeenMsAgo: now - m.lastSeen })),
        partitions: logs.map((l, p) => {
          const committed = this.commits.get(`${group}|${topic}|${p}`) ?? 0;
          // LAG = events written but not yet processed by this group. The #1 Kafka health metric.
          return { partition: p, committed, endOffset: l.endOffset, lag: l.endOffset - committed };
        }),
      };
    });
    return json({ topics, groups, stats: this.stats });
  }

  // ------------------------------------------------------------------ command dispatch

  execute(argv: string[]): Reply {
    const cmd = argv[0].toUpperCase();
    const a = argv.slice(1);
    const int = (s: string | undefined) => (s !== undefined && /^-?\d+$/.test(s) ? Number(s) : NaN);
    const need = (n: number) => (a.length < n ? err("ERR", `wrong number of arguments for '${cmd.toLowerCase()}'`) : null);
    // Partition / offset / generation arguments must be whole numbers. Without this, "abc" became
    // NaN, slipped past range checks (NaN < 0 is false) and was stored as an offset (found in code review).
    const ints = (...idx: number[]) =>
      idx.some((i) => !Number.isSafeInteger(int(a[i]))) ? err("INVALID_ARGUMENT", "partition/offset/generation must be whole numbers") : null;

    switch (cmd) {
      case "PING":
        return new SimpleString("PONG");
      case "CREATETOPIC": {
        const bad = need(2);
        if (bad) return bad;
        const n = int(a[1]);
        if (!TOPIC_NAME.test(a[0])) return err("INVALID_TOPIC", "use letters, digits, '.' and '_'");
        if (!(n >= 1 && n <= 64)) return err("INVALID_PARTITIONS", "1..64");
        return this.createTopic(a[0], n);
      }
      case "PRODUCE": {
        // PRODUCE topic key value [headersJson]
        const bad = need(3);
        if (bad) return bad;
        let headers: Record<string, string> = {};
        if (a[3]) {
          try {
            headers = JSON.parse(a[3]) as Record<string, string>;
          } catch {
            return err("INVALID_HEADERS", "headers must be a JSON object");
          }
        }
        return this.produce(a[0], a[1], a[2], headers);
      }
      case "FETCH": // FETCH topic partition offset max
        return need(4) ?? ints(1, 2, 3) ?? this.fetch(a[0], int(a[1]), int(a[2]), int(a[3]));
      case "JOIN": // JOIN group topic memberId
        return need(3) ?? this.join(a[0], a[1], a[2]);
      case "HEARTBEAT": // HEARTBEAT group memberId
        return need(2) ?? this.heartbeat(a[0], a[1]);
      case "LEAVE":
        return need(2) ?? this.leave(a[0], a[1]);
      case "COMMIT": // COMMIT group topic partition offset memberId generation
        return need(6) ?? ints(2, 3, 5) ?? this.commit(a[0], a[1], int(a[2]), int(a[3]), a[4], int(a[5]));
      case "COMMITTED": // COMMITTED group topic
        return need(2) ?? this.committed(a[0], a[1]);
      case "SETOFFSET": // SETOFFSET group topic partition offset
        return need(4) ?? ints(2, 3) ?? this.setOffset(a[0], a[1], int(a[2]), int(a[3]));
      case "DESCRIBE":
        return this.describe();
      default:
        return err("ERR", `unknown command '${argv[0]}'`);
    }
  }
}
