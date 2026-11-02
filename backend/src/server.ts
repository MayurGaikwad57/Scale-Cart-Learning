import { createApp } from "./app.js";
import { broker } from "./config/broker.js";
import { env } from "./config/env.js";
import { kv } from "./config/kv.js";
import { startWorkers } from "./events/workers.js";

// ScaleKV is optional: without KV_URL (or while it is down) the API still works, just without
// caching / shared rate limits. The client reconnects on its own when ScaleKV comes back.
if (env.KV_URL) kv.connect(env.KV_URL);
else console.log("[kv] KV_URL not set - running without cache and rate limiting");

// ScaleLog (our Kafka) is optional too: without it orders work, but no events are published.
if (env.LOG_URL) {
  broker.conn.connect(env.LOG_URL);
  // In development the API also runs the consumers. `npm run worker` adds more members.
  if (env.RUN_WORKERS === "true") startWorkers();
} else {
  console.log("[log] LOG_URL not set - running without events");
}

createApp().listen(env.PORT, () => {
  console.log(`ScaleCart API listening on :${env.PORT}`);
});
