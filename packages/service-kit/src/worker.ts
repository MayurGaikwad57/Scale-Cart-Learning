import { broker } from "./broker.js";
import { startConsumers, stopConsumers, type ConsumerDef } from "./consumers.js";
import { kitEnv as env } from "./env.js";
import { kv } from "./kv.js";
import type { ServiceDb } from "./db.js";

/**
 * An EXTRA consumer process for one service's groups (no HTTP):   npm run worker -w @scalecart/<service>
 * Start it while the service runs and its groups REBALANCE: a topic has 3 partitions, so the service
 * keeps some and this worker takes the others. Ctrl+C -> they move back at once (graceful LEAVE);
 * kill it hard and the broker notices after ~10 s of missing heartbeats instead.
 */
export function runWorker(opts: { name: string; consumers: readonly ConsumerDef[]; db?: ServiceDb }) {
  const tag = `[${opts.name} worker]`;
  if (!env.LOG_URL) {
    console.error(`${tag} LOG_URL is not set - nothing to consume. Add it to apps/${opts.name}/.env and start the broker: npm run log`);
    process.exit(1);
  }
  broker.conn.connect(env.LOG_URL);
  if (env.KV_URL) kv.connect(env.KV_URL); // for the chaos switch
  startConsumers(opts.consumers);
  console.log(`${tag} pid ${process.pid} consuming: ${opts.consumers.map((c) => c.group).join(", ")}`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log(`${tag} leaving consumer groups...`);
    await stopConsumers();
    await opts.db?.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
