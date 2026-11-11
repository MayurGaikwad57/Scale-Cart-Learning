/**
 * Entry point of the ScaleLog broker process - our own Kafka:   npm run log
 *
 * Settings (optional, from the environment / backend/.env):
 *   LOG_PORT      default 9093 (9092 is real Kafka's port; we stay off it)
 *   LOG_HOST      default 127.0.0.1 (no authentication -> never expose it)
 *   LOG_DATA_DIR  default backend/data/scalelog - the partition log FILES (survive restarts)
 *   LOG_SESSION_TIMEOUT_MS  default 10000 - a consumer silent for this long is declared dead
 */
import "dotenv/config";
import path from "node:path";
import { startLogServer } from "./server.js";

const port = Number(process.env.LOG_PORT ?? 9093);
const host = process.env.LOG_HOST ?? "127.0.0.1";
const dataDir = path.resolve(process.env.LOG_DATA_DIR ?? "data/scalelog");
const sessionTimeoutMs = Number(process.env.LOG_SESSION_TIMEOUT_MS ?? 10_000);

const log = await startLogServer({ port, host, dataDir, sessionTimeoutMs }).catch((e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `[scalelog] port ${port} is already in use` : e);
  process.exit(1);
});
console.log(`[scalelog] broker listening on ${host}:${log.port}, data in ${dataDir}. Try: npm run log:cli -- DESCRIBE`);

const shutdown = async () => {
  console.log("[scalelog] shutting down");
  await log.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
