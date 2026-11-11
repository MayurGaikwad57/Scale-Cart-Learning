/**
 * An EXTRA consumer process for this service's groups (no HTTP):   npm run worker -w @scalecart/order
 * Start it while the service runs and its groups REBALANCE: the topic has 3 partitions, so the
 * service keeps some and this worker takes the others. Ctrl+C -> they move back at once (graceful
 * LEAVE); kill it hard and the broker notices after ~10 s of missing heartbeats instead.
 */
import { startConsumers, stopConsumers } from "@scalecart/service-kit/consumers";
import { kv } from "@scalecart/service-kit/kv";
import { broker } from "@scalecart/service-kit/broker";
import { env } from "./config/env.js";
import { db } from "./config/prisma.js";
import { consumers } from "./consumers.js";

if (!env.LOG_URL) {
  console.error("LOG_URL is not set - nothing to consume. Add it to apps/order/.env and start the broker: npm run log");
  process.exit(1);
}
broker.conn.connect(env.LOG_URL);
if (env.KV_URL) kv.connect(env.KV_URL); // for the chaos switch
startConsumers(consumers);
console.log(`[order worker] pid ${process.pid} consuming: ${consumers.map((c) => c.group).join(", ")}`);

const shutdown = async () => {
  console.log("[order worker] leaving consumer groups...");
  await stopConsumers();
  await db.disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
