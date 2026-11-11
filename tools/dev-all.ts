/**
 * Start the whole ScaleCart system in ONE terminal (from the repo root):   npm run dev
 *   or only some processes:                                                npm run dev -- gateway order inventory
 *   or the COMPILED apps (after npm run build), like production:          npm run start:all
 *
 *   kv           ScaleKV (our Redis)          :6380   apps/scalekv
 *   log          ScaleLog (our Kafka)         :9093   apps/scalelog
 *   inventory    Inventory Service            :3003   apps/inventory
 *   payment      Payment Service              :3002   apps/payment
 *   notification Notification Service         :3004   apps/notification
 *   order        Order Service                :3001   apps/order
 *   gateway      API Gateway                  :3000   apps/gateway   <- the only one the browser talks to
 *
 * Every app runs as its OWN process, started in its OWN folder, so it reads its OWN .env - exactly
 * like separate containers in production. This launcher is a development convenience only: in
 * production nothing is a "parent" of the services (Docker / Kubernetes start and restart them).
 * Every line of output is prefixed with the process name. To experiment with failures, run a service
 * in its own terminal instead (npm run dev -w @scalecart/payment) and stop / start it.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROCESSES: Record<string, { app: string; entry: string; watch: boolean; color: number }> = {
  kv: { app: "scalekv", entry: "kv-server", watch: false, color: 90 },
  log: { app: "scalelog", entry: "log-server", watch: false, color: 90 },
  inventory: { app: "inventory", entry: "main", watch: true, color: 33 },
  payment: { app: "payment", entry: "main", watch: true, color: 35 },
  notification: { app: "notification", entry: "main", watch: true, color: 36 },
  order: { app: "order", entry: "main", watch: true, color: 32 },
  gateway: { app: "gateway", entry: "main", watch: true, color: 34 },
};

const compiled = process.argv.includes("--compiled");
const wanted = process.argv.slice(2).filter((a) => a !== "--compiled");
const unknown = wanted.filter((w) => !(w in PROCESSES));
if (unknown.length) {
  console.error(`Unknown: ${unknown.join(", ")}. Choose from: ${Object.keys(PROCESSES).join(", ")}`);
  process.exit(1);
}
const names = wanted.length ? wanted : Object.keys(PROCESSES);

// dev:      each app's TypeScript source via `tsx watch` (restart on save); shared packages are used
//           as source too (--conditions=development), so editing them needs no rebuild.
// compiled: each app's dist/*.js with plain node - what a container runs.
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
const argsFor = (p: (typeof PROCESSES)[string]) =>
  compiled
    ? [`dist/${p.entry}.js`]
    : [tsxCli, ...(p.watch ? ["watch", "--clear-screen=false"] : []), "--conditions=development", `src/${p.entry}.ts`];
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
    if (stopping) return;
    const child = spawn(process.execPath, argsFor(p), {
      cwd: path.join(repoRoot, "apps", p.app), // -> the app reads ITS OWN .env
      env: { ...process.env, FORCE_COLOR: "1" },
    });
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
