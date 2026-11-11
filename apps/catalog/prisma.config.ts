import "dotenv/config";
import { defineConfig } from "prisma/config";

// The catalog service's OWN database: schema, migrations and connection are all inside apps/catalog.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["CATALOG_DATABASE_URL"] },
});
