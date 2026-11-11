/**
 * DATABASE PER SERVICE - create one database + one database user per service:   npm run db:create-service-dbs
 *
 *   identity     -> database scalecart_identity      user identity_svc
 *   catalog      -> database scalecart_catalog       user catalog_svc
 *   order        -> database scalecart_order         user order_svc
 *   inventory    -> database scalecart_inventory     user inventory_svc
 *   payment      -> database scalecart_payment       user payment_svc
 *   notification -> database scalecart_notification  user notification_svc
 *
 * Each user OWNS its database and is the ONLY one allowed to connect to it (CONNECT is revoked from
 * PUBLIC). So even a bug - or an attacker - in the payment service cannot read the order database:
 * PostgreSQL itself enforces the boundary, not just a code-review rule.
 *
 * Needs an ADMIN connection (a user allowed to create roles and databases) in ADMIN_DATABASE_URL
 * (root .env). Writes each service's own connection string into apps/<service>/.env (and all of them
 * into tests/system/.env, because the system tests run every service in one process).
 * Safe to run again: existing users get a NEW password, written to the .env files again.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const SERVICE_DBS = ["identity", "catalog", "order", "inventory", "payment", "notification"] as const;

const root = fileURLToPath(new URL("../", import.meta.url));
const adminUrl = process.env.ADMIN_DATABASE_URL;
if (!adminUrl) {
  console.error("Set ADMIN_DATABASE_URL in the root .env (a PostgreSQL user that may create roles and databases).");
  process.exit(1);
}

/** Set KEY=value in a .env file (replace the line if present, append otherwise). */
function setEnv(file: string, key: string, value: string) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const line = `${key}="${value}"`;
  const re = new RegExp(`^${key}=.*$`, "m");
  fs.writeFileSync(file, re.test(text) ? text.replace(re, line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`);
}

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const { hostname, port } = new URL(adminUrl);
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

for (const svc of SERVICE_DBS) {
  const role = `${svc}_svc`;
  const db = `scalecart_${svc}`;
  const password = randomBytes(18).toString("base64url"); // URL-safe: no escaping in the connection string

  const roleExists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount;
  // DDL can't take bind parameters; the names are ours and the password is base64url - still quoted safely.
  await admin.query(`${roleExists ? "ALTER" : "CREATE"} ROLE ${ident(role)} WITH LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  const dbExists = (await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [db])).rowCount;
  if (!dbExists) await admin.query(`CREATE DATABASE ${ident(db)} OWNER ${ident(role)}`);
  await admin.query(`REVOKE CONNECT ON DATABASE ${ident(db)} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${ident(db)} TO ${ident(role)}`);

  const url = `postgresql://${role}:${password}@${hostname}:${port || 5432}/${db}`;
  const key = `${svc.toUpperCase()}_DATABASE_URL`;
  setEnv(path.join(root, "apps", svc, ".env"), key, url);
  setEnv(path.join(root, "tests", "system", ".env"), key, url);
  console.log(`${db.padEnd(24)} owner ${role.padEnd(18)} ${dbExists ? "(existed)" : "(created)"} -> apps/${svc}/.env ${key}`);
}
await admin.end();
console.log("Done. Next: npm run db:deploy (creates each service's tables in its own database).");
