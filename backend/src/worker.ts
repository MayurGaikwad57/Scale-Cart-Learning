/**
 * A standalone consumer process:   npm run worker                    (all three groups)
 *                                  npm run worker -- notification     (just one group)
 *
 * Start it in a second terminal while the API is running and the group REBALANCES: the
 * "orders" topic has 3 partitions, so the API keeps some and this worker takes the others.
 * Press Ctrl+C and watch the partitions move back (graceful LEAVE). Kill it hard (close the
 * terminal) and the broker notices after ~10s of missing heartbeats instead.
 */
import { env } from "./config/env.js";
import { broker } from "./config/broker.js";
import { kv } from "./config/kv.js";
import { prisma } from "./config/prisma.js";
import { CONSUMER_GROUPS, startWorkers, stopWorkers, type ConsumerGroup } from "./events/workers.js";

if (!env.LOG_URL) {
  console.error("LOG_URL is not set - nothing to consume. Add it to backend/.env and start the broker with: npm run log");
  process.exit(1);
}
const wanted = process.argv.slice(2);
const bad = wanted.filter((g) => !CONSUMER_GROUPS.includes(g as ConsumerGroup));
if (bad.length) {
  console.error(`Unknown group(s): ${bad.join(", ")}. Choose from: ${CONSUMER_GROUPS.join(", ")}`);
  process.exit(1);
}

broker.conn.connect(env.LOG_URL);
if (env.KV_URL) kv.connect(env.KV_URL); // for the chaos switch
startWorkers(wanted.length ? (wanted as ConsumerGroup[]) : CONSUMER_GROUPS);
console.log(`[worker] pid ${process.pid} consuming: ${(wanted.length ? wanted : CONSUMER_GROUPS).join(", ")}`);

const shutdown = async () => {
  console.log("[worker] leaving consumer groups...");
  await stopWorkers();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
