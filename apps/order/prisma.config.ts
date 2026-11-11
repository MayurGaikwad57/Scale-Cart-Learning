import "dotenv/config";
import { defineConfig } from "prisma/config";

// The order service's OWN database: schema, migrations and connection are all inside apps/order.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["ORDER_DATABASE_URL"] },
});
