/**
 * ONE-TIME DATA MIGRATION: the old shared database -> one database per service.   npm run db:migrate-legacy-data
 *
 * Reads LEGACY_DATABASE_URL (root .env, the old shared database - left untouched as a backup) and
 * copies every row to the service that OWNS it. Each service's database is reached with that
 * service's own connection string (apps/<service>/.env).
 *
 *   identity     users
 *   catalog      products (+ the stock COPY from inventory)
 *   order        cart, cart_items, orders, order_items (+ a SNAPSHOT of each line's product),
 *                sales_daily, processed_events of the "order" / "analytics" groups
 *   inventory    inventory, product_info (sku + name copied from products), stock_alerts,
 *                reservations, reservation_items, processed_events of the "inventory" group
 *   payment      payments
 *   notification notifications, processed_events of the "notification" group
 *
 * Idempotent: rows that are already there are skipped (ON CONFLICT DO NOTHING), so it can run again.
 * In a real company this is the riskiest step of a database split: it runs with the services
 * stopped (or with a dual-write / CDC phase), then the row counts are compared, as below.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import pg from "pg";

const root = fileURLToPath(new URL("../", import.meta.url));
const legacyUrl = process.env.LEGACY_DATABASE_URL;
if (!legacyUrl) throw new Error("Set LEGACY_DATABASE_URL in the root .env (the old shared database).");
const serviceUrl = (svc: string) => {
  const key = `${svc.toUpperCase()}_DATABASE_URL`;
  const url = parse(fs.readFileSync(path.join(root, "apps", svc, ".env")))[key];
  if (!url) throw new Error(`${key} missing in apps/${svc}/.env - run npm run db:create-service-dbs first`);
  return url;
};

type Copy = { table: string; select: string; conflict: string };
const PLAN: Record<string, Copy[]> = {
  identity: [{ table: "users", select: "SELECT * FROM users", conflict: "(id)" }],
  catalog: [
    {
      table: "products",
      select: `SELECT p.*, COALESCE(i.available, 0) AS stock_available, COALESCE(i.version, -1) AS stock_version
               FROM products p LEFT JOIN inventory i ON i.product_id = p.id`,
      conflict: "(id)",
    },
  ],
  order: [
    { table: "cart", select: "SELECT * FROM cart", conflict: "(id)" },
    { table: "cart_items", select: "SELECT * FROM cart_items", conflict: "(id)" },
    { table: "orders", select: "SELECT * FROM orders", conflict: "(id)" },
    {
      table: "order_items",
      select: `SELECT oi.*, COALESCE(p.name, '(unknown product)') AS product_name, COALESCE(p.sku, '') AS product_sku,
                      COALESCE(p.category, '') AS product_category
               FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id`,
      conflict: "(id)",
    },
    { table: "sales_daily", select: "SELECT * FROM sales_daily", conflict: "(day)" },
    { table: "processed_events", select: "SELECT * FROM processed_events WHERE consumer_group IN ('order', 'analytics')", conflict: "(consumer_group, event_id)" },
  ],
  inventory: [
    { table: "inventory", select: "SELECT * FROM inventory", conflict: "(product_id)" },
    { table: "product_info", select: "SELECT id AS product_id, sku, name, now() AS updated_at FROM products", conflict: "(product_id)" },
    { table: "stock_alerts", select: "SELECT * FROM stock_alerts", conflict: "(product_id)" },
    { table: "reservations", select: "SELECT * FROM reservations", conflict: "(order_id)" },
    { table: "reservation_items", select: "SELECT * FROM reservation_items", conflict: "(order_id, product_id)" },
    { table: "processed_events", select: "SELECT * FROM processed_events WHERE consumer_group = 'inventory'", conflict: "(consumer_group, event_id)" },
  ],
  payment: [{ table: "payments", select: "SELECT * FROM payments", conflict: "(id)" }],
  notification: [
    { table: "notifications", select: "SELECT * FROM notifications", conflict: "(id)" },
    { table: "processed_events", select: "SELECT * FROM processed_events WHERE consumer_group = 'notification'", conflict: "(consumer_group, event_id)" },
  ],
};

const legacy = new pg.Client({ connectionString: legacyUrl });
await legacy.connect();
let mismatches = 0;

for (const [svc, copies] of Object.entries(PLAN)) {
  const target = new pg.Client({ connectionString: serviceUrl(svc) });
  await target.connect();
  for (const c of copies) {
    const rows = (await legacy.query(c.select)).rows as Record<string, unknown>[];
    // Only the columns the target table has (e.g. no stray columns from a join).
    const targetCols = new Set(
      (await target.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [c.table])).rows.map(
        (r: { column_name: string }) => r.column_name,
      ),
    );
    const cols = rows.length ? Object.keys(rows[0]).filter((k) => targetCols.has(k)) : [];
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200);
      const params: unknown[] = [];
      const values = batch.map((r) => `(${cols.map((col) => (params.push(r[col]), `$${params.length}`)).join(", ")})`);
      const res = await target.query(
        `INSERT INTO "${c.table}" (${cols.map((col) => `"${col}"`).join(", ")}) VALUES ${values.join(", ")} ON CONFLICT DO NOTHING`, // any unique conflict: skip (the count check reports it)
        params,
      );
      inserted += res.rowCount ?? 0;
    }
    const after = Number((await target.query(`SELECT count(*) FROM "${c.table}"`)).rows[0].count);
    const ok = after >= rows.length;
    if (!ok) mismatches++;
    console.log(`${ok ? "OK " : "!! "} ${(`${svc}.${c.table}`).padEnd(32)} source ${String(rows.length).padStart(5)}  inserted ${String(inserted).padStart(5)}  now ${String(after).padStart(5)}`);
  }
  await target.end();
}
await legacy.end();
if (mismatches) {
  console.error(`${mismatches} table(s) have fewer rows than the source - check the output above.`);
  process.exit(1);
}
console.log("Migration complete. The old database was NOT changed (it stays as a backup).");
