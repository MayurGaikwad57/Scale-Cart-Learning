/**
 * Entry point of the ScaleKV process:   npm run kv
 *
 * It is deliberately a SEPARATE process from the API. In production you run many API
 * instances; they can only share a cache / rate-limit counters if that state lives outside
 * all of them - that's the whole reason Redis exists. A Map inside the API would be per-instance.
 *
 * Settings (all optional, read from the environment / backend/.env):
 *   KV_PORT      default 6380 (6379 is real Redis' port; we stay off it to avoid confusion)
 *   KV_HOST      default 127.0.0.1 (no password -> never expose it to the network)
 *   KV_MAX_KEYS  default 10000 (beyond that the least-recently-used keys are evicted)
 */
import "dotenv/config";
import { startKvServer } from "./server.js";

const port = Number(process.env.KV_PORT ?? 6380);
const host = process.env.KV_HOST ?? "127.0.0.1";
const maxKeys = Number(process.env.KV_MAX_KEYS ?? 10_000);

const kv = await startKvServer({ port, host, maxKeys }).catch((err: NodeJS.ErrnoException) => {
  console.error(err.code === "EADDRINUSE" ? `[scalekv] port ${port} is already in use` : err);
  process.exit(1);
});
console.log(`[scalekv] listening on ${host}:${kv.port} (max ${maxKeys} keys). Try: npm run kv:cli`);

// Ctrl+C: close sockets cleanly. Data is in memory only, so it is gone after a restart -
// exactly like a Redis used purely as a cache with persistence switched off.
const shutdown = async () => {
  console.log("[scalekv] shutting down");
  await kv.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
