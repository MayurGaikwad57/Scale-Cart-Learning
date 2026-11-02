import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { kv } from "./config/kv.js";

// ScaleKV is optional: without KV_URL (or while it is down) the API still works, just without
// caching / shared rate limits. The client reconnects on its own when ScaleKV comes back.
if (env.KV_URL) kv.connect(env.KV_URL);
else console.log("[kv] KV_URL not set - running without cache and rate limiting");

createApp().listen(env.PORT, () => {
  console.log(`ScaleCart API listening on :${env.PORT}`);
});
