/**
 * ONE-TIME: move the users from the order service's database to the identity service's database.
 *   npm run db:move-users-to-identity      (run it BEFORE the order service's migration that drops `users`)
 *
 * This is the STRANGLER FIG again, for data: the identity service takes over the users; the order
 * service keeps only the user ids on its orders and carts (plain ids, no foreign key any more).
 * Idempotent (ON CONFLICT DO NOTHING); compares the row counts at the end.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import pg from "pg";

const root = fileURLToPath(new URL("../", import.meta.url));
const url = (svc: string) => parse(fs.readFileSync(path.join(root, "apps", svc, ".env")))[`${svc.toUpperCase()}_DATABASE_URL`];

const from = new pg.Client({ connectionString: url("order") });
const to = new pg.Client({ connectionString: url("identity") });
await Promise.all([from.connect(), to.connect()]);

const exists = (await from.query("SELECT to_regclass('public.users') AS t")).rows[0].t;
if (!exists) {
  console.log("The order database has no users table any more - nothing to move.");
} else {
  const rows = (await from.query("SELECT id, email, password_hash, role::text AS role, created_at FROM users")).rows;
  let moved = 0;
  for (const r of rows) {
    const res = await to.query(
      `INSERT INTO users (id, email, password_hash, role, created_at) VALUES ($1, $2, $3, $4::"Role", $5) ON CONFLICT (id) DO NOTHING`,
      [r.id, r.email, r.password_hash, r.role, r.created_at],
    );
    moved += res.rowCount ?? 0;
  }
  const inIdentity = Number((await to.query("SELECT count(*) FROM users")).rows[0].count);
  console.log(`order.users ${rows.length} -> identity.users: inserted ${moved}, identity now has ${inIdentity}`);
  if (inIdentity < rows.length) {
    console.error("identity has FEWER users than order - do NOT drop the order service's users table.");
    process.exit(1);
  }
}
await Promise.all([from.end(), to.end()]);
