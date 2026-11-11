import "dotenv/config";
import { defineConfig } from "prisma/config";

// The inventory service's OWN database: schema, migrations and connection are all inside apps/inventory.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["INVENTORY_DATABASE_URL"] },
});
