import "dotenv/config";
import { defineConfig } from "prisma/config";

// The payment service's OWN database: schema, migrations and connection are all inside apps/payment.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["PAYMENT_DATABASE_URL"] },
});
