import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { KvClient, KvCommandError, KvUnavailableError } from "./client.js";
import { encode, encodeCommand, RespError, RespParser, SimpleString } from "./resp.js";
import { startKvServer, type RunningKvServer } from "./server.js";
import { KvStore } from "./store.js";

describe("RESP protocol", () => {
  it("round-trips every type, including nested arrays and null", () => {
    const values = ["hello", 42, null, new SimpleString("OK"), new RespError("ERR bad"), ["a", 1, ["b", null]]];
    const p = new RespParser();
    p.push(Buffer.from(values.map(encode).join("")));
    for (const v of values) expect(p.next()).toEqual(v);
    expect(p.next()).toBeUndefined();
  });

  it("uses BYTE length for bulk strings (UTF-8)", () => {
    expect(encode("₹")).toBe("$3\r\n₹\r\n");
    const p = new RespParser();
    p.push(Buffer.from(encode("₹ price")));
    expect(p.next()).toBe("₹ price");
  });

  it("waits for more bytes when a value is split across TCP chunks", () => {
    const bytes = Buffer.from(encodeCommand(["SET", "key", "value"]));
    const p = new RespParser();
    for (let i = 0; i < bytes.length - 1; i++) {
      p.push(bytes.subarray(i, i + 1));
      expect(p.next()).toBeUndefined(); // not complete yet
    }
    p.push(bytes.subarray(bytes.length - 1));
    expect(p.next()).toEqual(["SET", "key", "value"]);
  });

  it("accepts inline (telnet-style) commands", () => {
    const p = new RespParser();
    p.push(Buffer.from("SET a 1\r\nGET a\r\n"));
    expect(p.next()).toEqual(["SET", "a", "1"]);
    expect(p.next()).toEqual(["GET", "a"]);
  });
});

describe("KvStore (the engine)", () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it("SET/GET/DEL/EXISTS and hit/miss statistics", () => {
    const s = new KvStore();
    expect(s.execute(["SET", "a", "1"])).toEqual(new SimpleString("OK"));
    expect(s.execute(["GET", "a"])).toBe("1");
    expect(s.execute(["GET", "missing"])).toBeNull();
    expect(s.execute(["EXISTS", "a", "missing"])).toBe(1);
    expect(s.execute(["DEL", "a", "missing"])).toBe(1);
    expect(s.stats).toMatchObject({ hits: 1, misses: 1 });
  });

  it("SET NX only writes when the key is absent (the lock / idempotency primitive)", () => {
    const s = new KvStore();
    expect(s.execute(["SET", "lock", "me", "NX"])).toEqual(new SimpleString("OK"));
    expect(s.execute(["SET", "lock", "you", "NX"])).toBeNull();
    expect(s.execute(["GET", "lock"])).toBe("me");
    expect(s.execute(["SET", "other", "x", "XX"])).toBeNull();
  });

  it("expires keys with PX/EX; TTL follows Redis conventions (-2 missing, -1 no TTL)", () => {
    const c = clock();
    const s = new KvStore({ now: c.now });
    s.execute(["SET", "a", "1", "PX", "1500"]);
    s.execute(["SET", "b", "1"]);
    expect(s.execute(["PTTL", "a"])).toBe(1500);
    expect(s.execute(["TTL", "a"])).toBe(2); // rounded up to seconds
    expect(s.execute(["TTL", "b"])).toBe(-1);
    expect(s.execute(["TTL", "nope"])).toBe(-2);
    c.advance(1500);
    expect(s.execute(["GET", "a"])).toBeNull(); // lazy expiry on access
    expect(s.stats.expiredKeys).toBe(1);
  });

  it("INCR is atomic-by-design, keeps the TTL, and refuses non-integers", () => {
    const c = clock();
    const s = new KvStore({ now: c.now });
    expect(s.execute(["INCR", "n"])).toBe(1);
    s.execute(["PEXPIRE", "n", "1000"]);
    expect(s.execute(["INCRBY", "n", "41"])).toBe(42);
    expect(s.execute(["PTTL", "n"])).toBe(1000);
    s.execute(["SET", "word", "abc"]);
    expect(s.execute(["INCR", "word"])).toEqual(new RespError("ERR value is not an integer or out of range"));
  });

  it("evicts the least-recently-USED key when full (not the oldest written)", () => {
    const s = new KvStore({ maxKeys: 3 });
    s.execute(["SET", "a", "1"]);
    s.execute(["SET", "b", "2"]);
    s.execute(["SET", "c", "3"]);
    s.execute(["GET", "a"]); // a is now the most recently used
    s.execute(["SET", "d", "4"]); // over the limit -> evict b
    expect(s.execute(["EXISTS", "a", "b", "c", "d"])).toBe(3);
    expect(s.execute(["GET", "b"])).toBeNull();
    expect(s.stats.evictedKeys).toBe(1);
  });

  it("evicts cache keys before protected keys (rate-limit counters, idempotency records)", () => {
    const s = new KvStore({ maxKeys: 3, protectedPrefixes: ["rl:", "idem:"] });
    s.execute(["SET", "rl:ip:1", "5"]); // oldest, but protected
    s.execute(["SET", "idem:order:k", "running"]);
    s.execute(["SET", "product:a", "x"]);
    s.execute(["SET", "product:b", "y"]); // over the limit
    expect(s.execute(["EXISTS", "rl:ip:1", "idem:order:k"])).toBe(2);
    expect(s.execute(["GET", "product:a"])).toBeNull(); // the cache entry went instead
    expect(s.execute(["GET", "product:b"])).toBe("y");
  });

  it("active expiry removes expired keys nobody reads", () => {
    const c = clock();
    const s = new KvStore({ now: c.now });
    for (let i = 0; i < 100; i++) s.execute(["SET", `k${i}`, "v", "PX", "10"]);
    s.execute(["SET", "keep", "v"]);
    c.advance(10);
    s.activeExpireCycle();
    expect(s.size).toBe(1);
  });

  it("reports errors as replies, never throws", () => {
    const s = new KvStore();
    expect(s.execute(["NOPE"])).toEqual(new RespError("ERR unknown command 'NOPE'"));
    expect(s.execute(["GET"])).toBeInstanceOf(RespError);
    expect(s.execute(["SET", "a", "1", "PX", "-5"])).toBeInstanceOf(RespError);
  });
});

describe("ScaleKV server + client over real TCP", () => {
  let server: RunningKvServer | undefined;
  const clients: KvClient[] = [];
  const newClient = (opts = {}) => {
    const c = new KvClient({ log: false, ...opts });
    clients.push(c);
    return c;
  };
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.disconnect()));
    await server?.close();
    server = undefined;
  });

  it("serves commands; replies match commands even when pipelined", async () => {
    server = await startKvServer({ port: 0 });
    const c = newClient();
    c.connect(`kv://127.0.0.1:${server.port}`);
    await c.waitUntilReady();
    // 200 commands in flight at once over one connection.
    const results = await Promise.all(Array.from({ length: 200 }, () => c.incr("counter")));
    expect(results).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(await c.set("k", "v", { nx: true })).toBe(true);
    expect(await c.set("k", "v2", { nx: true })).toBe(false);
    expect(await c.get("k")).toBe("v");
    await expect(c.command("INCR", "k")).rejects.toBeInstanceOf(KvCommandError);
    expect((await c.info()).keys).toBe("2");
  });

  it("a FROZEN server (connection open, no replies) is detected after 3 timeouts -> fail fast", async () => {
    const sockets: net.Socket[] = [];
    const frozen = net.createServer((s) => void sockets.push(s)); // accepts, never answers
    await new Promise<void>((r) => frozen.listen(0, "127.0.0.1", r));
    const c = newClient({ commandTimeoutMs: 30 });
    c.connect(`kv://127.0.0.1:${(frozen.address() as net.AddressInfo).port}`);
    await c.waitUntilReady();
    // Stop accepting NEW connections (the open one stays frozen), so reconnects keep failing.
    const closed = new Promise((r) => frozen.close(r));
    for (let i = 0; i < 3; i++) await expect(c.get("k")).rejects.toThrow("timed out");
    await expect.poll(() => c.status).toBe("down");
    const started = Date.now();
    await expect(c.get("k")).rejects.toBeInstanceOf(KvUnavailableError);
    expect(Date.now() - started).toBeLessThan(20); // no more waiting for timeouts
    await c.disconnect();
    sockets.forEach((s) => s.destroy());
    await closed;
  });

  it("two clients share one store - that is the point of a separate process", async () => {
    server = await startKvServer({ port: 0 });
    const a = newClient();
    const b = newClient();
    a.connect(`kv://127.0.0.1:${server.port}`);
    b.connect(`kv://127.0.0.1:${server.port}`);
    await Promise.all([a.waitUntilReady(), b.waitUntilReady()]);
    await a.set("shared", "from-a");
    expect(await b.get("shared")).toBe("from-a");
  });

  it("fails fast while the server is down and reconnects when it is back", async () => {
    server = await startKvServer({ port: 0 });
    const port = server.port;
    const c = newClient();
    c.connect(`kv://127.0.0.1:${port}`);
    await c.waitUntilReady();

    await server.close();
    server = undefined;
    await expect.poll(() => c.status).toBe("down");
    const started = Date.now();
    await expect(c.get("x")).rejects.toBeInstanceOf(KvUnavailableError);
    expect(Date.now() - started).toBeLessThan(50); // rejected immediately, not after a timeout

    server = await startKvServer({ port });
    await c.waitUntilReady(3000);
    expect(await c.command("PING")).toEqual(new SimpleString("PONG"));
  });

  it("a command that gets no reply times out, and its late reply is not given to the next command", async () => {
    // A fake server that, like a real one, answers strictly IN ORDER - but stalls for 300ms
    // first (think: a slow command blocking it). Every command received during the stall is
    // answered afterwards, in order: "reply-1", "reply-2", ...
    const sockets: net.Socket[] = [];
    const slow = net.createServer((s) => {
      sockets.push(s);
      const parser = new RespParser();
      let received = 0;
      let answered = 0;
      let stalled = true;
      const flush = () => {
        while (answered < received) s.write(encode(`reply-${++answered}`));
      };
      setTimeout(() => {
        stalled = false;
        flush();
      }, 300);
      s.on("data", (chunk) => {
        parser.push(chunk);
        while (parser.next() !== undefined) received++;
        if (!stalled) flush();
      });
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
    const port = (slow.address() as net.AddressInfo).port;
    const c = newClient({ commandTimeoutMs: 200 });
    c.connect(`kv://127.0.0.1:${port}`);
    await c.waitUntilReady();

    await expect(c.get("first")).rejects.toThrow("timed out"); // t=200ms, no reply yet
    // Sent at t=200ms while "reply-1" is still owed. At t=300ms both replies arrive together.
    // A buggy client would hand "reply-1" (meant for "first") to this command.
    expect(await c.get("second")).toBe("reply-2");

    await c.disconnect();
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => slow.close(r));
  });
});
