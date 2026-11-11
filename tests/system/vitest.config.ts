import "dotenv/config"; // load tests/system/.env FIRST, so a DATABASE_POOL_MAX there wins over the default below
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Many tests wait for asynchronous work crossing several services and the broker
    // (checkout -> OrderCreated -> payment -> OrderConfirmed -> inventory/notification).
    testTimeout: 20_000,
    // Every test file starts ALL services (each with its own DB pool): cap the files running at once
    // so the connections stay within PostgreSQL's limit.
    maxWorkers: 3,
    // ...and each service's pool small: 3 files x 6 services x 4 = 72 connections (PostgreSQL allows
    // 100). A DATABASE_POOL_MAX in tests/system/.env or the shell overrides this default (CI has none).
    env: { DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX ?? "4" },
  },
});
