import { OK, RespError, SimpleString, type Reply } from "./resp.js";

/**
 * The data engine of ScaleKV - our own small Redis. No networking here (that's server.ts),
 * which keeps it easy to test with a fake clock.
 *
 * Why commands are ATOMIC without any locks: Node runs JavaScript on ONE thread, and
 * execute() never awaits. So a command like INCR runs start-to-finish before the next command
 * from any client is even looked at. Real Redis is single-threaded for exactly this reason.
 *
 * Only the string type is implemented (plus integers stored as strings, like Redis does).
 * Real Redis also has lists, hashes, sets and sorted sets.
 */

interface Entry {
  value: string;
  expiresAt?: number; // epoch ms; undefined = lives forever
}

export interface StoreOptions {
  /** Max number of keys. Above it, the least-recently-used key is evicted (like maxmemory + allkeys-lru). */
  maxKeys?: number;
  /**
   * Keys starting with these prefixes are evicted only if nothing else can be. A cache entry can
   * always be rebuilt from the database; a rate-limit counter or an idempotency record cannot.
   * (With real Redis you'd typically run a separate instance for such state, or use volatile-lru.)
   */
  protectedPrefixes?: string[];
  /** Injectable clock so tests can "travel in time". */
  now?: () => number;
}

const wrongArgs = (cmd: string) => new RespError(`ERR wrong number of arguments for '${cmd}' command`);
const notInteger = new RespError("ERR value is not an integer or out of range");
const syntaxError = new RespError("ERR syntax error");

const toInt = (s: string): number | undefined => (/^-?\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : undefined);

/** Redis glob pattern (* ? [abc]) -> RegExp. Used only by KEYS. */
const globToRegExp = (glob: string) =>
  new RegExp(
    "^" +
      glob.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") +
      "$",
  );

export class KvStore {
  /**
   * A JS Map remembers insertion order. We re-insert a key every time it is used, so the
   * FIRST key in the map is always the least recently used one -> O(1) LRU eviction.
   * (Real Redis approximates LRU by sampling a few keys, to save memory per key.)
   */
  private readonly data = new Map<string, Entry>();
  /** Keys that have a TTL - the active-expiry cycle only needs to look at these. */
  private readonly volatile = new Set<string>();
  private volatileCursor: Iterator<string> | null = null;

  private readonly maxKeys: number;
  private readonly protectedPrefixes: string[];
  private readonly now: () => number;
  private readonly startedAt: number;

  readonly stats = { commands: 0, hits: 0, misses: 0, expiredKeys: 0, evictedKeys: 0 };

  constructor(opts: StoreOptions = {}) {
    this.maxKeys = opts.maxKeys ?? 10_000;
    this.protectedPrefixes = opts.protectedPrefixes ?? [];
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
  }

  get size() {
    return this.data.size;
  }

  // ---------------------------------------------------------------- internals

  /** Returns a live entry. LAZY EXPIRY: an expired key is deleted the moment someone touches it. */
  private lookup(key: string, touch = true): Entry | undefined {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== undefined && e.expiresAt <= this.now()) {
      this.remove(key);
      this.stats.expiredKeys++;
      return undefined;
    }
    if (touch) {
      // Move to the "most recently used" end.
      this.data.delete(key);
      this.data.set(key, e);
    }
    return e;
  }

  private remove(key: string) {
    this.volatile.delete(key);
    return this.data.delete(key);
  }

  private write(key: string, e: Entry) {
    this.data.delete(key);
    this.data.set(key, e);
    if (e.expiresAt === undefined) this.volatile.delete(key);
    else this.volatile.add(key);
    // EVICTION: over the limit -> drop the least recently used key(s).
    while (this.data.size > this.maxKeys) {
      this.remove(this.evictionCandidate(key));
      this.stats.evictedKeys++;
    }
  }

  /** Least recently used key that isn't protected (looks at the 64 oldest), else the oldest one. */
  private evictionCandidate(justWritten: string): string {
    let checked = 0;
    let fallback: string | undefined;
    for (const k of this.data.keys()) {
      if (k === justWritten) continue; // never evict the key we are writing right now
      fallback ??= k;
      if (!this.protectedPrefixes.some((p) => k.startsWith(p))) return k;
      if (++checked >= 64) break;
    }
    return fallback ?? justWritten;
  }

  /**
   * ACTIVE EXPIRY. Lazy expiry alone would leave never-read expired keys in memory forever,
   * so the server calls this ~10 times a second (Redis does the same, with sampling):
   * check up to `sample` keys that have a TTL; if many of them were expired, keep going,
   * but never for longer than `budgetMs` so normal commands are not starved.
   */
  activeExpireCycle(sample = 20, budgetMs = 5) {
    const deadline = Date.now() + budgetMs;
    const now = this.now();
    let removed = 0;
    for (;;) {
      let checked = 0;
      let expiredNow = 0;
      while (checked < sample) {
        this.volatileCursor ??= this.volatile.values();
        const next = this.volatileCursor.next();
        if (next.done) {
          this.volatileCursor = null; // wrap around next time
          break;
        }
        checked++;
        const e = this.data.get(next.value);
        if (e?.expiresAt !== undefined && e.expiresAt <= now) {
          this.remove(next.value);
          this.stats.expiredKeys++;
          expiredNow++;
        }
      }
      removed += expiredNow;
      // Fewer than 25% expired -> memory is in good shape, stop.
      if (checked === 0 || expiredNow / checked < 0.25 || Date.now() > deadline) return removed;
    }
  }

  private ttlMs(key: string): number {
    const e = this.lookup(key, false);
    if (!e) return -2; // Redis convention: -2 = no such key
    if (e.expiresAt === undefined) return -1; // -1 = exists, no TTL
    return e.expiresAt - this.now();
  }

  private incrBy(key: string, by: number): Reply {
    const e = this.lookup(key);
    const current = e ? toInt(e.value) : 0;
    if (current === undefined) return notInteger;
    const next = current + by;
    if (!Number.isSafeInteger(next)) return notInteger;
    // INCR keeps an existing TTL (rate limiting relies on this).
    this.write(key, { value: String(next), expiresAt: e?.expiresAt });
    return next;
  }

  private set(args: string[]): Reply {
    const [key, value, ...opts] = args;
    let expiresAt: number | undefined;
    let nx = false;
    let xx = false;
    let keepTtl = false;
    for (let i = 0; i < opts.length; i++) {
      const opt = opts[i].toUpperCase();
      if (opt === "NX") nx = true;
      else if (opt === "XX") xx = true;
      else if (opt === "KEEPTTL") keepTtl = true;
      else if (opt === "EX" || opt === "PX") {
        const n = toInt(opts[++i] ?? "");
        if (n === undefined || n <= 0) return new RespError("ERR invalid expire time in 'set' command");
        expiresAt = this.now() + (opt === "EX" ? n * 1000 : n);
      } else return syntaxError;
    }
    if (nx && xx) return syntaxError;

    const existing = this.lookup(key, false);
    // NX = "only if Not eXists": the building block for locks and idempotency keys.
    if (nx && existing) return null;
    if (xx && !existing) return null;
    if (keepTtl && existing) expiresAt = existing.expiresAt;
    this.write(key, { value, expiresAt });
    return OK;
  }

  info(extra: Record<string, string | number> = {}): string {
    const lookups = this.stats.hits + this.stats.misses;
    const fields: Record<string, string | number> = {
      server: "scalekv",
      uptime_seconds: Math.floor((this.now() - this.startedAt) / 1000),
      ...extra,
      keys: this.data.size,
      keys_with_ttl: this.volatile.size,
      max_keys: this.maxKeys,
      total_commands_processed: this.stats.commands,
      keyspace_hits: this.stats.hits,
      keyspace_misses: this.stats.misses,
      hit_rate_percent: lookups ? Math.round((this.stats.hits / lookups) * 1000) / 10 : 0,
      expired_keys: this.stats.expiredKeys,
      evicted_keys: this.stats.evictedKeys,
      used_memory_rss_bytes: process.memoryUsage().rss,
    };
    return Object.entries(fields)
      .map(([k, v]) => `${k}:${v}`)
      .join("\r\n");
  }

  // ---------------------------------------------------------------- commands

  /** Runs one command, e.g. ["SET", "a", "1", "PX", "5000"]. Never throws: errors are replies. */
  execute(argv: string[], extraInfo?: Record<string, string | number>): Reply {
    if (argv.length === 0) return new RespError("ERR empty command");
    this.stats.commands++;
    const cmd = argv[0].toUpperCase();
    const args = argv.slice(1);
    const need = (min: number, max = min) => args.length < min || args.length > max;

    switch (cmd) {
      case "PING":
        if (need(0, 1)) return wrongArgs("ping");
        return args.length ? args[0] : new SimpleString("PONG");
      case "ECHO":
        if (need(1)) return wrongArgs("echo");
        return args[0];

      case "GET": {
        if (need(1)) return wrongArgs("get");
        const e = this.lookup(args[0]);
        if (e) this.stats.hits++;
        else this.stats.misses++;
        return e ? e.value : null;
      }
      case "SET":
        if (args.length < 2) return wrongArgs("set");
        return this.set(args);
      case "DEL":
        if (args.length < 1) return wrongArgs("del");
        return args.filter((k) => this.lookup(k, false) && this.remove(k)).length;
      case "EXISTS":
        if (args.length < 1) return wrongArgs("exists");
        return args.filter((k) => this.lookup(k, false)).length;

      case "INCR":
        if (need(1)) return wrongArgs("incr");
        return this.incrBy(args[0], 1);
      case "DECR":
        if (need(1)) return wrongArgs("decr");
        return this.incrBy(args[0], -1);
      case "INCRBY": {
        if (need(2)) return wrongArgs("incrby");
        const by = toInt(args[1]);
        return by === undefined ? notInteger : this.incrBy(args[0], by);
      }

      case "EXPIRE":
      case "PEXPIRE": {
        if (need(2)) return wrongArgs(cmd.toLowerCase());
        const n = toInt(args[1]);
        if (n === undefined) return notInteger;
        const e = this.lookup(args[0], false);
        if (!e) return 0;
        const expiresAt = this.now() + (cmd === "EXPIRE" ? n * 1000 : n);
        this.write(args[0], { value: e.value, expiresAt });
        return 1;
      }
      case "PERSIST": {
        if (need(1)) return wrongArgs("persist");
        const e = this.lookup(args[0], false);
        if (!e || e.expiresAt === undefined) return 0;
        this.write(args[0], { value: e.value });
        return 1;
      }
      case "TTL":
      case "PTTL": {
        if (need(1)) return wrongArgs(cmd.toLowerCase());
        const ms = this.ttlMs(args[0]);
        return ms < 0 || cmd === "PTTL" ? ms : Math.ceil(ms / 1000);
      }

      case "KEYS": {
        // O(N) over every key and blocks everyone meanwhile - fine for debugging in kv-cli,
        // never use it in application code (that's why the app invalidates with versioned keys).
        if (need(1)) return wrongArgs("keys");
        const re = globToRegExp(args[0]);
        return [...this.data.keys()].filter((k) => re.test(k) && this.lookup(k, false));
      }
      case "DBSIZE":
        return this.data.size;
      case "FLUSHALL":
      case "FLUSHDB":
        this.data.clear();
        this.volatile.clear();
        this.volatileCursor = null;
        return OK;
      case "INFO":
        return this.info(extraInfo);

      default:
        return new RespError(`ERR unknown command '${argv[0]}'`);
    }
  }
}
