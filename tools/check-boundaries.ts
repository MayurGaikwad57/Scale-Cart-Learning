/**
 * BOUNDARY CHECK - the rule that makes these real microservices:   npm run check:boundaries
 *
 *   An app may import:   its own files, the shared packages (@scalecart/service-kit, @scalecart/events)
 *                        and npm libraries.
 *   An app may NOT import another app (@scalecart/order, ...) or reach outside its folder (../../).
 *
 * Need another service's data? Call its API or listen to its events. Only tests/system (which
 * starts the whole system) may import several apps. Runs in CI; a violation fails the build.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const appsDir = path.join(root, "apps");
const apps = fs.readdirSync(appsDir).filter((d) => fs.existsSync(path.join(appsDir, d, "package.json")));
const appPackages = new Set(apps.map((a) => `@scalecart/${a}`));

const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return ["node_modules", "dist", "generated", "data"].includes(e.name) ? [] : files(p);
    return /\.(ts|mts)$/.test(e.name) ? [p] : [];
  });

// import x from "m" | export x from "m" | import "m" (side effect) | import("m") | require("m")
const IMPORT = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;
const problems: string[] = [];

for (const app of apps) {
  const appRoot = path.join(appsDir, app);
  for (const file of files(path.join(appRoot, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      const where = `${path.relative(root, file)}: "${spec}"`;
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (appPackages.has(pkg) && pkg !== `@scalecart/${app}`) problems.push(`${where} -> imports ANOTHER service (${pkg})`);
      if (spec.startsWith(".")) {
        const target = path.resolve(path.dirname(file), spec);
        if (!target.startsWith(appRoot + path.sep)) problems.push(`${where} -> reaches outside apps/${app}`);
      }
    }
  }
}

if (problems.length) {
  console.error(`Service boundary violations (${problems.length}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`Service boundaries OK: ${apps.length} apps, none imports another.`);
