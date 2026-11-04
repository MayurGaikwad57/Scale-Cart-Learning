import { env } from "../../config/env.js";
import { kv } from "../../config/kv.js";
import { serviceUrls } from "../registry.js";
import { createGatewayApp } from "./app.js";

// npm run svc:gateway. The gateway has no database: it only needs ScaleKV for the shared rate limit.
if (env.KV_URL) kv.connect(env.KV_URL);

const server = createGatewayApp().listen(env.PORT, () => {
  console.log(`[gateway] API gateway listening on :${env.PORT} (pid ${process.pid})`);
  for (const [name, url] of Object.entries(serviceUrls)) console.log(`[gateway]   ${name.padEnd(12)} -> ${url}`);
});

const shutdown = async () => {
  server.close();
  await kv.disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
