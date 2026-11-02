import net from "node:net";
import { encodeCommand, RespError, RespParser, type Reply } from "./resp.js";

/**
 * disabled   - no KV_URL configured (or disconnect() was called): the app runs without a cache.
 * connecting - first connection attempt in progress.
 * ready      - connected; commands are sent.
 * down       - connection lost; reconnecting in the background with exponential backoff.
 */
export type KvStatus = "disabled" | "connecting" | "ready" | "down";

/** ScaleKV can't be used right now. Callers catch this and DEGRADE (skip cache, allow request...). */
export class KvUnavailableError extends Error {}
/** ScaleKV answered with an error reply (e.g. INCR on a non-number). That's a bug, not an outage. */
export class KvCommandError extends Error {}

interface Pending {
  resolve(r: Reply): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

export interface KvClientOptions {
  commandTimeoutMs?: number;
  maxConsecutiveTimeouts?: number;
  connectTimeoutMs?: number;
  log?: boolean;
}

/**
 * Client for ScaleKV (would also work against real Redis - same protocol).
 *
 * Design decisions worth knowing for interviews:
 *  - ONE TCP connection, PIPELINED: many commands can be in flight; replies come back in the
 *    same order, so a FIFO queue of "pending" promises is enough to match them up.
 *  - FAIL FAST: if we are not connected, commands are rejected immediately instead of queued.
 *    A cache must never make the app slower than having no cache at all.
 *  - TIMEOUTS: a command that gets no reply in `commandTimeoutMs` is rejected. Its queue slot
 *    stays (marked settled) so that a late reply is thrown away instead of being handed to the
 *    NEXT command - that misalignment would be a nasty bug.
 *  - RECONNECT with exponential backoff (100ms, 200ms, 400ms ... max 5s) so a restarted
 *    ScaleKV is picked up automatically without hammering it while it's down.
 *  - CIRCUIT BREAKER: a server that is "up but frozen" (TCP open, no replies) is worse than a
 *    dead one: every request would wait the full timeout. After `maxConsecutiveTimeouts`
 *    timeouts in a row we drop the connection ourselves -> status "down" -> fail fast, and the
 *    normal reconnect logic probes it again. Any reply resets the count.
 */
export class KvClient {
  status: KvStatus = "disabled";
  url: string | undefined;

  private socket: net.Socket | undefined;
  private parser = new RespParser();
  private pending: Pending[] = [];
  private host = "127.0.0.1";
  private port = 6380;
  private retryMs = 100;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private closing = false;
  private consecutiveTimeouts = 0;
  private readonly opts: Required<KvClientOptions>;

  constructor(opts: KvClientOptions = {}) {
    this.opts = { commandTimeoutMs: 250, connectTimeoutMs: 1000, maxConsecutiveTimeouts: 3, log: true, ...opts };
  }

  get isReady() {
    return this.status === "ready";
  }

  /** url like "kv://127.0.0.1:6380". Returns immediately; the connection is made in the background. */
  connect(url: string) {
    const u = new URL(url);
    this.url = url;
    this.host = u.hostname;
    this.port = Number(u.port || 6380);
    this.closing = false;
    this.retryMs = 100;
    this.open();
  }

  /** Resolves once connected (or rejects after timeoutMs). Handy at startup and in tests. */
  waitUntilReady(timeoutMs = 2000): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (this.isReady) return resolve();
        if (Date.now() - started > timeoutMs) return reject(new KvUnavailableError(`kv not ready (${this.status})`));
        setTimeout(check, 10);
      };
      check();
    });
  }

  async disconnect() {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    const s = this.socket;
    if (!s) {
      this.setStatus("disabled");
      return;
    }
    await new Promise<void>((done) => {
      s.once("close", () => done());
      s.destroy();
    });
  }

  // ------------------------------------------------------------ connection handling

  private setStatus(next: KvStatus) {
    if (this.status === next) return;
    const prev = this.status;
    this.status = next;
    if (!this.opts.log) return;
    if (next === "ready") console.log(`[kv] connected to ${this.host}:${this.port}`);
    else if (next === "down" && prev !== "connecting") console.warn(`[kv] connection lost - running without cache, retrying in background`);
    else if (next === "down") console.warn(`[kv] cannot reach ${this.host}:${this.port} - running without cache, retrying in background`);
  }

  private open() {
    this.parser = new RespParser();
    if (this.status === "disabled") this.setStatus("connecting");
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setTimeout(this.opts.connectTimeoutMs);
    socket.once("connect", () => {
      socket.setTimeout(0);
      this.consecutiveTimeouts = 0;
      this.retryMs = 100;
      this.setStatus("ready");
    });
    socket.on("timeout", () => socket.destroy());
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", () => undefined); // "close" always follows; handled there
    socket.on("close", () => this.onClose(socket));
  }

  private onClose(socket: net.Socket) {
    if (socket !== this.socket) return;
    this.socket = undefined;
    // Everything in flight is lost: we'll never know if those commands ran.
    for (const p of this.pending.splice(0)) this.settle(p, new KvUnavailableError("kv connection closed"));
    if (this.closing) {
      this.setStatus("disabled");
      return;
    }
    this.setStatus("down");
    this.reconnectTimer = setTimeout(() => this.open(), this.retryMs);
    this.reconnectTimer.unref();
    this.retryMs = Math.min(this.retryMs * 2, 5000);
  }

  private onData(chunk: Buffer | string) {
    this.parser.push(chunk);
    try {
      for (let r = this.parser.next(); r !== undefined; r = this.parser.next()) {
        this.consecutiveTimeouts = 0; // the server is answering
        const p = this.pending.shift();
        if (!p || p.settled) continue; // late reply of a timed-out command: drop it
        this.settle(p, r instanceof RespError ? new KvCommandError(r.message) : undefined, r);
      }
    } catch {
      this.socket?.destroy(); // unparseable stream -> reconnect for a clean state
    }
  }

  private onTimeout(p: Pending, socket: net.Socket) {
    this.settle(p, new KvUnavailableError("kv command timed out"));
    if (++this.consecutiveTimeouts >= this.opts.maxConsecutiveTimeouts && socket === this.socket) {
      if (this.opts.log) console.warn(`[kv] ${this.consecutiveTimeouts} timeouts in a row - treating ScaleKV as down`);
      this.consecutiveTimeouts = 0;
      socket.destroy(); // -> onClose: fails everything pending, status "down", reconnect with backoff
    }
  }

  private settle(p: Pending, err?: Error, value?: Reply) {
    if (p.settled) return;
    p.settled = true;
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(value ?? null);
  }

  // ------------------------------------------------------------ commands

  /** Send any command, e.g. command("SET", "k", "v", "PX", 1000). */
  command(...args: (string | number)[]): Promise<Reply> {
    const socket = this.socket;
    if (this.status !== "ready" || !socket) return Promise.reject(new KvUnavailableError(`kv is ${this.status}`));
    return new Promise<Reply>((resolve, reject) => {
      const p: Pending = {
        resolve,
        reject,
        settled: false,
        timer: setTimeout(() => this.onTimeout(p, socket), this.opts.commandTimeoutMs),
      };
      this.pending.push(p);
      socket.write(encodeCommand(args));
    });
  }

  async get(key: string): Promise<string | null> {
    return (await this.command("GET", key)) as string | null;
  }

  /** Returns false when NX/XX prevented the write. */
  async set(key: string, value: string, opts: { pxMs?: number; nx?: boolean } = {}): Promise<boolean> {
    const args: (string | number)[] = ["SET", key, value];
    if (opts.pxMs) args.push("PX", Math.max(1, Math.round(opts.pxMs)));
    if (opts.nx) args.push("NX");
    return (await this.command(...args)) !== null;
  }

  async del(...keys: string[]): Promise<number> {
    return (await this.command("DEL", ...keys)) as number;
  }

  async incr(key: string): Promise<number> {
    return (await this.command("INCR", key)) as number;
  }

  async pttl(key: string): Promise<number> {
    return (await this.command("PTTL", key)) as number;
  }

  /** INFO parsed into an object: { keys: "12", keyspace_hits: "40", ... } */
  async info(): Promise<Record<string, string>> {
    const text = (await this.command("INFO")) as string;
    return Object.fromEntries(
      text
        .split("\r\n")
        .filter((l) => l.includes(":"))
        .map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1)]),
    );
  }
}
