/**
 * Our "redis-cli":   npm run kv:cli            (interactive)
 *                    npm run kv:cli -- GET k   (one command, then exit)
 *
 * Type commands like:  PING · SET greeting hello EX 30 · GET greeting · TTL greeting
 *                      KEYS * · INFO · DBSIZE
 *
 * With --log it talks to the ScaleLog broker instead (npm run log:cli), e.g.
 *                      DESCRIBE · FETCH orders 0 0 10 · COMMITTED notification orders
 */
import "dotenv/config";
import readline from "node:readline";
import { KvClient } from "@scalecart/service-kit/kv/client";
import { RespError, SimpleString, type Reply } from "@scalecart/service-kit/kv/resp";

const useLog = process.argv.includes("--log");
const url = useLog
  ? (process.env.LOG_URL ?? `kv://127.0.0.1:${process.env.LOG_PORT ?? 9093}`)
  : (process.env.KV_URL ?? `kv://127.0.0.1:${process.env.KV_PORT ?? 6380}`);
const label = useLog ? "scalelog" : "scalekv";
const client = new KvClient({ log: false, commandTimeoutMs: 5000 });
client.connect(url);
try {
  await client.waitUntilReady(2000);
} catch {
  console.error(`Could not connect to ${label} at ${url}. Start it with: npm run ${useLog ? "log" : "kv"}`);
  process.exit(1);
}

// Show replies the way redis-cli does.
function show(r: Reply, indent = ""): string {
  if (r === null) return `${indent}(nil)`;
  if (typeof r === "number") return `${indent}(integer) ${r}`;
  if (r instanceof SimpleString) return `${indent}${r.value}`;
  if (r instanceof RespError) return `${indent}(error) ${r.message}`;
  if (Array.isArray(r)) return r.length ? r.map((x, i) => show(x, `${indent}${i + 1}) `)).join("\n") : `${indent}(empty array)`;
  return r.includes("\r\n") ? r.replaceAll("\r\n", "\n") : `${indent}"${r}"`;
}

// Split on spaces but keep "quoted strings" together:  SET msg "hello world"
const tokenize = (line: string) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);

async function run(args: string[]) {
  try {
    console.log(show(await client.command(...args)));
  } catch (err) {
    console.log(`(error) ${(err as Error).message}`);
  }
}

const oneShot = process.argv.slice(2).filter((a) => a !== "--log");
if (oneShot.length) {
  await run(oneShot);
  await client.disconnect();
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${label} ${url.replace("kv://", "")}> ` });
  rl.prompt();
  rl.on("line", async (line) => {
    const args = tokenize(line.trim());
    if (args[0]?.toLowerCase() === "quit" || args[0]?.toLowerCase() === "exit") return rl.close();
    if (args.length) await run(args);
    rl.prompt();
  });
  rl.on("close", () => void client.disconnect().then(() => process.exit(0)));
}
