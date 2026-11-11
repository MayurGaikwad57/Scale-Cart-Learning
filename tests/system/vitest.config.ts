import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Many tests wait for asynchronous work crossing several services and the broker
    // (checkout -> OrderCreated -> payment -> OrderConfirmed -> inventory/notification).
    testTimeout: 20_000,
    // Every test file starts ALL services (each with its own DB pool): cap the files running at once
    // so the connections stay within PostgreSQL's limit (see DATABASE_POOL_MAX in .env).
    maxWorkers: 3,
  },
});
