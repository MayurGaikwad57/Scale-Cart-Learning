import "dotenv/config";
import { defineConfig } from "prisma/config";

// The notification service's OWN database: schema, migrations and connection are all inside apps/notification.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["NOTIFICATION_DATABASE_URL"] },
});
