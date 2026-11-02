import { KvClient } from "../kv/client.js";
import { LogClient } from "../log/client.js";

// The one connection to the ScaleLog broker (our Kafka). server.ts / worker.ts connect it when
// LOG_URL is set. Same RESP transport as ScaleKV; a longer timeout because every append is fsync'ed.
export const broker = new LogClient(
  new KvClient({ name: "log", degradedNote: "events are not being published", commandTimeoutMs: 3000 }),
);
