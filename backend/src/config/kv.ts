import { KvClient } from "../kv/client.js";

// The one shared ScaleKV connection for the whole API (server.ts connects it when KV_URL is set).
// When it isn't connected, every feature built on it degrades instead of failing.
export const kv = new KvClient();
