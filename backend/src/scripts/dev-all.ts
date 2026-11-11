/**
 * Start the whole ScaleCart system in ONE terminal:      npm run dev
 *   or only some processes:                               npm run dev -- gateway order inventory
 *
 *   kv           ScaleKV (our Redis)          :6380
 *   log          ScaleLog (our Kafka)         :9093
 *   inventory    Inventory Service            :3003
 *   payment      Payment Service              :3002
 *   notification Notification Service         :3004
 *   order        Order Service                :3001
 *   gateway      API Gateway                  :3000   <- the only one the browser talks to
 *
 * Every line of output is prefixed with the process name, so you can follow one checkout as it
 * travels gateway -> order -> inventory -> (event) -> payment -> order -> notification.
 * To experiment with failures, run a service in its OWN terminal instead (npm run svc:payment)
 * and stop / start it while the others keep running.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROCESSES: Record<string, { file: string; watch: boolean; color: number }> = {
  kv: { file: "src/kv/kv-server.ts", watch: false, color: 90 },
  log: { file: "src/log/log-server.ts", watch: false, color: 90 },
  inventory: { file: "src/services/inventory/main.ts", watch: true, color: 33 },
  payment: { file: "src/services/payment/main.ts", watch: true, color: 35 },
  notification: { file: "src/services/notification/main.ts", watch: true, color: 36 },
  order: { file: "src/services/order/main.ts", watch: true, color: 32 },
  gateway: { file: "src/services/gateway/main.ts", watch: true, color: 34 },
};

const wanted = process.argv.slice(2);
const unknown = wanted.filter((w) => !(w in PROCESSES));
if (unknown.length) {
  console.error(`Unknown: ${unknown.join(", ")}. Choose from: ${Object.keys(PROCESSES).join(", ")}`);
  process.exit(1);
}
const names = wanted.length ? wanted : Object.keys(PROCESSES);

// Two modes (found in code review: `npm start` used to run the dev watcher on the .ts sources):
//  - dev   (npm run dev): this file runs as .ts via tsx -> children run the .ts sources via
//          `tsx watch` (restart on save).
//  - build (npm run build && npm start): this file is dist/src/scripts/dev-all.js -> children run
//          the COMPILED dist/src/**/*.js with plain node: no tsx, no watching.
// Paths are resolved from this file's location, so the current directory doesn't matter.
const compiled = import.meta.url.endsWith(".js");
const backendRoot = fileURLToPath(new URL(compiled ? "../../../" : "../../", import.meta.url));
const tsxCli = compiled ? "" : fileURLToPath(import.meta.resolve("tsx/cli"));
const argsFor = (p: { file: string; watch: boolean }) =>
  compiled
    ? [`dist/${p.file.replace(/\.ts$/, ".js")}`]
    : [tsxCli, ...(p.watch ? ["watch", "--clear-screen=false"] : []), "--conditions=development", p.file];
const width = Math.max(...names.map((n) => n.length));
const children: ChildProcess[] = [];

function prefixLines(name: string, color: number, chunk: Buffer, out: NodeJS.WriteStream) {
  const tag = `\x1b[${color}m${name.padEnd(width)} |\x1b[0m `;
  for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) out.write(tag + line + "\n");
}

names.forEach((name, i) => {
  const p = PROCESSES[name];
  // Start infrastructure first; services 1.5s later so their first connection attempt succeeds
  // (they would reconnect on their own anyway - this just keeps the startup log tidy).
  const delay = p.watch ? 1500 + i * 150 : 0;
  setTimeout(() => {
    const child = spawn(process.execPath, argsFor(p), { cwd: backendRoot, env: { ...process.env, FORCE_COLOR: "1" } });
    child.stdout.on("data", (c: Buffer) => prefixLines(name, p.color, c, process.stdout));
    child.stderr.on("data", (c: Buffer) => prefixLines(name, p.color, c, process.stderr));
    child.on("exit", (code) => prefixLines(name, p.color, Buffer.from(`exited (code ${code})`), process.stdout));
    children.push(child);
  }, delay);
});

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  console.log("\nStopping all processes...");
  // Give each process a moment to shut down gracefully (consumers leave their groups)...
  setTimeout(() => {
    for (const c of children) {
      if (c.exitCode !== null || !c.pid) continue;
      // ...then make sure. On Windows a plain kill() would orphan the grandchild that `tsx watch`
      // starts, so kill the whole process TREE.
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
      else c.kill("SIGTERM");
    }
    process.exit(0);
  }, 2500);
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
