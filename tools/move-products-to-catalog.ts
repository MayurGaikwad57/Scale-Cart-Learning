/**
 * ONE-TIME: move the products from the order service's database to the catalog service's database.
 *   npm run db:move-products-to-catalog    (BEFORE the order migration 2_products_moved_to_catalog)
 *
 * Copies every product (with its stock copy and version), idempotent (ON CONFLICT DO NOTHING), and
 * compares the counts. The order service keeps only product ids on carts, and a SNAPSHOT of name /
 * sku / category / price on order lines (filled by its migration from these same rows).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import pg from "pg";

const root = fileURLToPath(new URL("../", import.meta.url));
const url = (svc: string) => parse(fs.readFileSync(path.join(root, "apps", svc, ".env")))[`${svc.toUpperCase()}_DATABASE_URL`];

const from = new pg.Client({ connectionString: url("order") });
const to = new pg.Client({ connectionString: url("catalog") });
await Promise.all([from.connect(), to.connect()]);

if (!(await from.query("SELECT to_regclass('public.products') AS t")).rows[0].t) {
  console.log("The order database has no products table any more - nothing to move.");
} else {
  const cols = ["id", "sku", "name", "description", "price_cents", "category", "active", "created_at", "stock_available", "stock_version"];
  const rows = (await from.query(`SELECT ${cols.join(", ")} FROM products`)).rows;
  let moved = 0;
  for (const r of rows) {
    const res = await to.query(
      `INSERT INTO products (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT DO NOTHING`, // ANY unique conflict (id or sku) is skipped, not fatal
      cols.map((c) => r[c]),
    );
    moved += res.rowCount ?? 0;
  }
  const inCatalog = Number((await to.query("SELECT count(*) FROM products")).rows[0].count);
  console.log(`order.products ${rows.length} -> catalog.products: inserted ${moved}, catalog now has ${inCatalog}`);
  // A product whose ID is not in the catalog was skipped because its SKU exists there under another id.
  const found = await to.query("SELECT id FROM products WHERE id = ANY($1::uuid[])", [rows.map((r) => r.id)]);
  const ids = new Set(found.rows.map((r) => r.id));
  const clashes = rows.filter((r) => !ids.has(r.id));
  if (clashes.length) {
    console.error("NOT moved (sku already in the catalog under another id): " + clashes.map((r) => r.sku).join(", "));
    process.exit(1);
  }
  if (inCatalog < rows.length) {
    console.error("catalog has FEWER products than order - do NOT run the order migration that drops them.");
    process.exit(1);
  }
}
await Promise.all([from.end(), to.end()]);
