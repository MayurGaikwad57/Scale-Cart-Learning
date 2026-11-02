import net from "node:net";
import { encode, OK, ProtocolError, RespError, RespParser, type Reply } from "./resp.js";

/**
 * A generic RESP-over-TCP server: accepts connections, parses commands, calls `execute`, and
 * writes the replies back IN ORDER (that's what makes pipelining work). Shared by ScaleKV (our
 * Redis) and ScaleLog (our Kafka) - they differ only in what `execute` does.
 *
 * `execute` is synchronous on purpose: Node runs it on one thread, so each command finishes
 * before the next one starts -> every command is atomic without locks.
 */
export interface RespServerOptions {
  port?: number; // 0 = any free port (tests)
  host?: string;
  execute: (argv: string[], ctx: { clients: number }) => Reply;
}

export interface RunningRespServer {
  port: number;
  close(): Promise<void>;
}

export function serveResp(opts: RespServerOptions & { defaultPort: number }): Promise<RunningRespServer> {
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
          let reply: Reply;
          try {
            reply = opts.execute(cmd as string[], { clients: sockets.size });
          } catch (err) {
            reply = new RespError(`ERR ${(err as Error).message}`); // a bug must not kill the server
          }
          out += encode(reply);
        }
      } catch (err) {
        // Garbage on the wire: we can no longer tell where the next command starts -> hang up.
        const msg = err instanceof ProtocolError ? err.message : "internal error";
        socket.end(out + encode(new RespError(`ERR Protocol error: ${msg}`)));
        return;
      }
      if (out) socket.write(out); // one write for all replies of this chunk
    });

    socket.on("error", () => socket.destroy()); // client vanished
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // 127.0.0.1 by default: no password, so it must not be reachable from the network.
    server.listen(opts.port ?? opts.defaultPort, opts.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
