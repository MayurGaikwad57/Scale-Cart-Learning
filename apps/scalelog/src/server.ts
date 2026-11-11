import { serveResp } from "@scalecart/service-kit/kv/resp-server";
import { Broker, type BrokerOptions } from "./broker.js";

export interface LogServerOptions extends BrokerOptions {
  port?: number; // 0 = any free port (tests)
  host?: string;
}

export interface RunningLogServer {
  port: number;
  broker: Broker;
  close(): Promise<void>;
}

/** ScaleLog network server = generic RESP server + the Broker engine (same transport as ScaleKV). */
export async function startLogServer(opts: LogServerOptions): Promise<RunningLogServer> {
  const broker = new Broker(opts);
  const server = await serveResp({
    port: opts.port,
    host: opts.host,
    defaultPort: 9093,
    execute: (argv) => broker.execute(argv),
  });
  // Every second: drop members whose heartbeats stopped (crash detection) and rebalance.
  const ticker = setInterval(() => broker.tick(), 1000);
  ticker.unref();
  let closed = false;
  return {
    port: server.port,
    broker,
    close: async () => {
      if (closed) return; // idempotent: closing twice must not close the log files twice
      closed = true;
      clearInterval(ticker);
      await server.close();
      broker.close();
    },
  };
}
