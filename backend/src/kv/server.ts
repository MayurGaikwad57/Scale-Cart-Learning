import net from "node:net";
import { encode, ProtocolError, RespError, RespParser, OK } from "./resp.js";
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

/**
 * ScaleKV network server: accepts TCP connections and answers RESP commands.
 *
 * PIPELINING comes for free: a client may send 3 commands in one packet without waiting; we
 * parse them in arrival order and write the replies in the same order, so the client can
 * match reply #n to command #n.
 */
export function startKvServer(opts: KvServerOptions = {}): Promise<RunningKvServer> {
  const store = new KvStore(opts);
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true); // send small replies immediately instead of batching (Nagle)
    const parser = new RespParser();

    socket.on("data", (chunk) => {
      parser.push(chunk);
      let out = "";
      try {
        for (let cmd = parser.next(); cmd !== undefined; cmd = parser.next()) {
          if (!Array.isArray(cmd) || !cmd.every((a) => typeof a === "string")) {
            out += encode(new RespError("ERR commands must be arrays of strings"));
            continue;
          }
          if (cmd.length === 0) continue;
          if (cmd[0].toUpperCase() === "QUIT") {
            socket.end(out + encode(OK));
            return;
          }
          out += encode(store.execute(cmd as string[], { connected_clients: sockets.size }));
        }
      } catch (err) {
        // Garbage on the wire: we can no longer tell where the next command starts -> hang up.
        const msg = err instanceof ProtocolError ? err.message : "internal error";
        socket.end(out + encode(new RespError(`ERR Protocol error: ${msg}`)));
        return;
      }
      if (out) socket.write(out); // one write for all replies of this chunk
    });

    socket.on("error", () => socket.destroy()); // client vanished; nothing to clean but the socket
    socket.on("close", () => sockets.delete(socket));
  });

  // Background cleanup of expired keys, 10x per second. unref(): don't keep the process alive.
  const expiry = setInterval(() => store.activeExpireCycle(), 100);
  expiry.unref();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // 127.0.0.1 by default: ScaleKV has no password, so it must not be reachable from the network.
    server.listen(opts.port ?? 6380, opts.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        port: (server.address() as net.AddressInfo).port,
        store,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(expiry);
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
