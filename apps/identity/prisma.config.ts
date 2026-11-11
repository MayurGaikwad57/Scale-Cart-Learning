import "dotenv/config";
import { defineConfig } from "prisma/config";

// The identity service's OWN database: schema, migrations and connection are all inside apps/identity.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["IDENTITY_DATABASE_URL"] },
});
