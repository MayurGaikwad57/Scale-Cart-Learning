import { serveResp } from "@scalecart/service-kit/kv/resp-server";
import { KvStore, type StoreOptions } from "./store.js";

export interface KvServerOptions extends StoreOptions {
  port?: number; // 0 = pick any free port (used by tests)
  host?: string;
}

export interface RunningKvServer {
  port: number;
  store: KvStore;
  close(): Promise<void>;
}

/** ScaleKV network server = the generic RESP server (resp-server.ts) + the KvStore engine. */
export async function startKvServer(opts: KvServerOptions = {}): Promise<RunningKvServer> {
  const store = new KvStore(opts);
  const server = await serveResp({
    port: opts.port,
    host: opts.host,
    defaultPort: 6380,
    execute: (argv, ctx) => store.execute(argv, { connected_clients: ctx.clients }),
  });

  // Background cleanup of expired keys, 10x per second. unref(): don't keep the process alive.
  const expiry = setInterval(() => store.activeExpireCycle(), 100);
  expiry.unref();

  return {
    port: server.port,
    store,
    close: async () => {
      clearInterval(expiry);
      await server.close();
    },
  };
}
