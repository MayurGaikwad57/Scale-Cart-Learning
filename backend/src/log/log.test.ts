import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KvClient, KvCommandError } from "../kv/client.js";
import { RespError } from "../kv/resp.js";
import { Broker, hashKey } from "./broker.js";
import { LogClient } from "./client.js";
import { Consumer } from "./consumer.js";
import { startLogServer, type RunningLogServer } from "./server.js";
import { PartitionLog } from "./storage.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "scalelog-test-"));
const parse = <T>(r: unknown) => JSON.parse(r as string) as T;
type Assign = { generation: number; partitions: number[] };

describe("PartitionLog (an append-only file)", () => {
  it("assigns increasing offsets and survives a restart", () => {
    const file = path.join(tmpDir(), "t-0.log");
    const a = new PartitionLog(file);
    expect([a.append({ key: "k", value: "v0", headers: {} }).offset, a.append({ key: "k", value: "v1", headers: {} }).offset]).toEqual([0, 1]);
    a.close();
    const b = new PartitionLog(file); // "restart"
    expect(b.endOffset).toBe(2);
    expect(b.read(1, 10).map((r) => r.value)).toEqual(["v1"]);
    expect(b.append({ key: "k", value: "v2", headers: {} }).offset).toBe(2);
    b.close();
  });

  it("cuts off a torn (half-written) last record after a crash", () => {
    const file = path.join(tmpDir(), "t-0.log");
    const a = new PartitionLog(file);
    a.append({ key: "k", value: "ok", headers: {} });
    a.close();
    fs.appendFileSync(file, '{"offset":1,"timestamp":1,"key":"k","val'); // power cut mid-write
    const b = new PartitionLog(file);
    expect(b.endOffset).toBe(1);
    expect(b.append({ key: "k", value: "next", headers: {} }).offset).toBe(1); // continues cleanly
    b.close();
    expect(new PartitionLog(file).read(0, 10).map((r) => r.value)).toEqual(["ok", "next"]);
  });

  it("drops a complete-looking record whose newline never made it to disk (no glued records)", () => {
    const file = path.join(tmpDir(), "t-0.log");
    const a = new PartitionLog(file);
    a.append({ key: "k", value: "ok", headers: {} });
    a.close();
    // Crash exactly between '}' and the newline: valid JSON, but the write never finished.
    fs.appendFileSync(file, JSON.stringify({ offset: 1, timestamp: 1, key: "k", value: "unacked", headers: {} }));
    const b = new PartitionLog(file);
    expect(b.endOffset).toBe(1);
    b.append({ key: "k", value: "next", headers: {} });
    b.close();
    // Before the fix, "next" was glued onto the unterminated line and BOTH were lost on restart.
    expect(new PartitionLog(file).read(0, 10).map((r) => r.value)).toEqual(["ok", "next"]);
  });
});

describe("Broker (topics, partitions, groups, offsets)", () => {
  const brokers: Broker[] = [];
  const make = (dataDir = tmpDir(), now?: () => number) => {
    const b = new Broker({ dataDir, sessionTimeoutMs: 1000, now });
    brokers.push(b);
    return b;
  };
  afterEach(() => brokers.splice(0).forEach((b) => b.close()));

  it("sends the same key to the same partition every time (per-key ordering)", () => {
    const b = make();
    b.execute(["CREATETOPIC", "orders", "3"]);
    const partitionOf = (key: string) => (b.execute(["PRODUCE", "orders", key, "{}"]) as number[])[0];
    expect(new Set([1, 2, 3, 4].map(() => partitionOf("order-42"))).size).toBe(1);
    expect(partitionOf("order-42")).toBe(hashKey("order-42") % 3);
    const spread = new Set(Array.from({ length: 30 }, (_, i) => partitionOf(`order-${i}`)));
    expect(spread.size).toBe(3); // different keys use all partitions
  });

  it("reads from any offset and rejects offsets beyond the end", () => {
    const b = make();
    b.execute(["CREATETOPIC", "t", "1"]);
    for (const v of ["a", "b", "c"]) b.execute(["PRODUCE", "t", "k", v]);
    const page = parse<{ records: { value: string }[]; endOffset: number }>(b.execute(["FETCH", "t", "0", "1", "10"]));
    expect(page.records.map((r) => r.value)).toEqual(["b", "c"]);
    expect(page.endOffset).toBe(3);
    expect((b.execute(["FETCH", "t", "0", "9", "10"]) as RespError).message).toMatch(/^OFFSET_OUT_OF_RANGE/);
  });

  it("divides partitions among group members and bumps the generation on every change", () => {
    const b = make();
    b.execute(["CREATETOPIC", "orders", "3"]);
    const a1 = parse<Assign>(b.execute(["JOIN", "g", "orders", "a"]));
    expect(a1.partitions).toEqual([0, 1, 2]);
    b.execute(["JOIN", "g", "orders", "b"]);
    const a2 = parse<Assign>(b.execute(["HEARTBEAT", "g", "a"]));
    const b2 = parse<Assign>(b.execute(["HEARTBEAT", "g", "b"]));
    expect([a2.partitions, b2.partitions]).toEqual([[0, 1], [2]]);
    expect(a2.generation).toBeGreaterThan(a1.generation);
    b.execute(["JOIN", "g", "orders", "c"]);
    b.execute(["JOIN", "g", "orders", "d"]); // 4 members, 3 partitions -> one member idles
    const sizes = ["a", "b", "c", "d"].map((m) => parse<Assign>(b.execute(["HEARTBEAT", "g", m])).partitions.length);
    expect(sizes.sort()).toEqual([0, 1, 1, 1]);
  });

  it("removes a member that stops sending heartbeats and gives its partitions away", () => {
    let t = 0;
    const b = make(tmpDir(), () => t);
    b.execute(["CREATETOPIC", "orders", "3"]);
    b.execute(["JOIN", "g", "orders", "a"]);
    b.execute(["JOIN", "g", "orders", "b"]);
    t = 800;
    b.execute(["HEARTBEAT", "g", "a"]); // a is alive, b says nothing
    t = 1500;
    b.tick();
    expect(parse<Assign>(b.execute(["HEARTBEAT", "g", "a"])).partitions).toEqual([0, 1, 2]);
    expect((b.execute(["HEARTBEAT", "g", "b"]) as RespError).message).toMatch(/^UNKNOWN_MEMBER/);
  });

  it("fences zombies: a commit with an old generation or for someone else's partition is rejected", () => {
    const b = make();
    b.execute(["CREATETOPIC", "orders", "3"]);
    b.execute(["PRODUCE", "orders", "", "x"]);
    const old = parse<Assign>(b.execute(["JOIN", "g", "orders", "a"]));
    b.execute(["JOIN", "g", "orders", "b"]); // rebalance: a keeps [0,1], b gets [2]
    const now = parse<Assign>(b.execute(["HEARTBEAT", "g", "a"]));
    const p0 = String(0);
    expect((b.execute(["COMMIT", "g", "orders", p0, "0", "a", String(old.generation)]) as RespError).message).toMatch(/^ILLEGAL_GENERATION/);
    expect((b.execute(["COMMIT", "g", "orders", "2", "0", "a", String(now.generation)]) as RespError).message).toMatch(/^NOT_ASSIGNED/);
    expect(b.execute(["COMMIT", "g", "orders", p0, "0", "a", String(now.generation)])).toMatchObject({ value: "OK" });
  });

  it("keeps committed offsets across a broker restart (they live in __consumer_offsets)", () => {
    const dir = tmpDir();
    const b = make(dir);
    b.execute(["CREATETOPIC", "orders", "1"]);
    for (let i = 0; i < 5; i++) b.execute(["PRODUCE", "orders", "k", String(i)]);
    const a = parse<Assign>(b.execute(["JOIN", "g", "orders", "m"]));
    b.execute(["COMMIT", "g", "orders", "0", "3", "m", String(a.generation)]);
    b.close();
    brokers.splice(0);
    const restarted = make(dir);
    expect(parse<Record<string, number>>(restarted.execute(["COMMITTED", "g", "orders"]))[0]).toBe(3);
    expect(parse<{ topics: { name: string }[] }>(restarted.execute(["DESCRIBE"])).topics.map((t) => t.name)).toEqual(["orders"]);
  });

  it("rejects offsets / partitions / generations that are not whole numbers", () => {
    const b = make();
    b.execute(["CREATETOPIC", "t", "1"]);
    b.execute(["PRODUCE", "t", "k", "v"]);
    const a = parse<Assign>(b.execute(["JOIN", "g", "t", "m"]));
    const code = (r: unknown) => (r as RespError).message.split(" ")[0];
    expect(code(b.execute(["COMMIT", "g", "t", "0", "abc", "m", String(a.generation)]))).toBe("INVALID_ARGUMENT");
    expect(code(b.execute(["FETCH", "t", "x", "0", "10"]))).toBe("INVALID_ARGUMENT");
    b.execute(["LEAVE", "g", "m"]);
    expect(code(b.execute(["SETOFFSET", "g", "t", "0", "abc"]))).toBe("INVALID_ARGUMENT");
    expect(parse<Record<string, number | null>>(b.execute(["COMMITTED", "g", "t"]))[0]).toBeNull(); // nothing stored
  });

  it("only lets an admin reset offsets of an idle group", () => {
    const b = make();
    b.execute(["CREATETOPIC", "t", "1"]);
    b.execute(["PRODUCE", "t", "k", "v"]);
    b.execute(["JOIN", "g", "t", "m"]);
    expect((b.execute(["SETOFFSET", "g", "t", "0", "1"]) as RespError).message).toMatch(/^GROUP_ACTIVE/);
    b.execute(["LEAVE", "g", "m"]);
    expect(b.execute(["SETOFFSET", "g", "t", "0", "1"])).toMatchObject({ value: "OK" });
  });
});

describe("Consumer assignment handling", () => {
  it("adopts a new assignment even when the generation NUMBER repeats (broker restarted)", async () => {
    // A stub broker: the member first gets [0] at generation 3; after a "broker restart"
    // generations start over and reach 3 again, but with partition [1].
    let assignment = { generation: 3, partitions: [0], members: 2 };
    const stub = {
      isReady: true,
      createTopic: async () => 3,
      join: async () => assignment,
      heartbeat: async () => assignment,
      committed: async () => ({}),
      fetch: async () => ({ records: [], endOffset: 0 }),
      leave: async () => undefined,
    } as unknown as LogClient;
    const c = new Consumer({ client: stub, group: "g", topic: "orders", handle: async () => undefined, log: false, pollIdleMs: 10, heartbeatMs: 20 });
    c.start();
    await expect.poll(() => c.partitions.join(",")).toBe("0");
    assignment = { generation: 3, partitions: [1], members: 2 };
    await expect.poll(() => c.partitions.join(","), { timeout: 2000 }).toBe("1");
    await c.stop();
  });
});

describe("Consumer groups over real TCP", () => {
  let server: RunningLogServer;
  const conns: KvClient[] = [];
  const consumers: Consumer[] = [];
  const client = async () => {
    const conn = new KvClient({ log: false, name: "log", commandTimeoutMs: 3000 });
    conn.connect(`kv://127.0.0.1:${server.port}`);
    await conn.waitUntilReady();
    conns.push(conn);
    return new LogClient(conn);
  };
  const consumer = (c: LogClient, group: string, handle: (v: unknown, m: { partition: number; offset: number }) => Promise<void>, extra = {}) => {
    const x = new Consumer({ client: c, group, topic: "orders", topicPartitions: 3, handle, log: false, pollIdleMs: 30, heartbeatMs: 100, backoffMs: () => 10, ...extra });
    consumers.push(x);
    return x;
  };
  const setup = async () => {
    server = await startLogServer({ port: 0, dataDir: tmpDir(), sessionTimeoutMs: 1000 });
    const c = await client();
    await c.createTopic("orders", 3);
    return c;
  };
  afterEach(async () => {
    await Promise.all(consumers.splice(0).map((c) => c.stop()));
    await Promise.all(conns.splice(0).map((c) => c.disconnect()));
    await server.close();
  });

  it("delivers every event, keeps per-key order, and commits progress", async () => {
    const c = await setup();
    for (let i = 0; i < 30; i++) await c.produce("orders", `order-${i % 5}`, JSON.stringify({ key: `order-${i % 5}`, seq: i }));
    const seen: { key: string; seq: number }[] = [];
    consumer(c, "g", async (v) => void seen.push(v as { key: string; seq: number })).start();
    await expect.poll(() => seen.length, { timeout: 5000 }).toBe(30);
    for (let k = 0; k < 5; k++) {
      const seqs = seen.filter((e) => e.key === `order-${k}`).map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // in the order they were produced
    }
    await expect.poll(async () => Object.values(await c.committed("g", "orders")).reduce((s: number, n) => s + (n ?? 0), 0)).toBe(30);
  });

  it("retries a failing event and succeeds without losing it", async () => {
    const c = await setup();
    await c.produce("orders", "k", JSON.stringify({ n: 1 }));
    let calls = 0;
    const x = consumer(c, "g", async () => {
      if (++calls < 3) throw new Error("database briefly unavailable");
    });
    x.start();
    await expect.poll(() => x.metrics.processed, { timeout: 5000 }).toBe(1);
    expect(calls).toBe(3);
    expect(x.metrics.retries).toBe(2);
    expect(x.metrics.deadLettered).toBe(0);
  });

  it("moves a poison event to the DLQ after maxAttempts and keeps the partition flowing", async () => {
    const c = await setup();
    await c.produce("orders", "same-key", JSON.stringify({ bad: true }));
    await c.produce("orders", "same-key", JSON.stringify({ bad: false }));
    const ok: unknown[] = [];
    const x = consumer(c, "g", async (v) => {
      if ((v as { bad: boolean }).bad) throw new Error("cannot handle this one");
      ok.push(v);
    });
    x.start();
    await expect.poll(() => ok.length, { timeout: 5000 }).toBe(1); // the next event was not blocked
    expect(x.metrics.deadLettered).toBe(1);
    const dlq = await c.fetch("orders.g.dlq", 0, 0, 10);
    expect(dlq.records).toHaveLength(1);
    expect(dlq.records[0].headers).toMatchObject({ "x-error": "cannot handle this one", "x-attempts": "3", "x-consumer-group": "g" });
  });

  it("rebalances: two members split the partitions, and when one leaves the other takes over", async () => {
    const c = await setup();
    const handled: string[] = [];
    const handle = async (v: unknown) => void handled.push((v as { id: string }).id);
    const a = consumer(await client(), "g", handle);
    const b = consumer(await client(), "g", handle);
    a.start();
    b.start();
    await expect.poll(() => [a.partitions.length, b.partitions.length].sort().join(","), { timeout: 5000 }).toBe("1,2");
    await b.stop(); // graceful LEAVE
    await expect.poll(() => a.partitions.length, { timeout: 5000 }).toBe(3);
    for (let i = 0; i < 12; i++) await c.produce("orders", `k${i}`, JSON.stringify({ id: `e${i}` }));
    await expect.poll(() => new Set(handled).size, { timeout: 5000 }).toBe(12); // nothing lost
  });

  it("at-least-once: a member that crashes before committing gets its event redelivered to another member", async () => {
    const c = await setup();
    await c.produce("orders", "k", JSON.stringify({ id: "only-event" }));
    // A "zombie" member: joins, reads the event, "processes" it ... and dies before COMMIT.
    const zombie = await client();
    const assignment = await zombie.join("g", "orders", "zombie");
    expect(assignment.partitions).toEqual([0, 1, 2]);
    const handled: string[] = ["only-event (by zombie, never committed)"];
    await zombie.conn.disconnect(); // no LEAVE, no more heartbeats
    // A healthy member joins; once the broker expires the zombie (session timeout) it gets everything.
    const healthy = consumer(c, "g", async (v) => void handled.push((v as { id: string }).id));
    healthy.start();
    await expect.poll(() => handled.length, { timeout: 8000 }).toBe(2);
    expect(handled[1]).toBe("only-event"); // processed twice in total: the duplicate consumers must tolerate
  });

  it("does not let a fenced zombie overwrite the new owner's progress", async () => {
    const c = await setup();
    const zombie = await client();
    const old = await zombie.join("g", "orders", "zombie");
    await c.join("g", "orders", "newcomer"); // rebalance -> new generation
    await expect(zombie.commit("g", "orders", 0, 0, "zombie", old.generation)).rejects.toBeInstanceOf(KvCommandError);
  });
});
