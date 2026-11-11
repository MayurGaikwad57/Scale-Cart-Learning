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
    // ...and each service's pool small: 3 files x 6 services x 4 = 72 connections (PostgreSQL allows
    // 100). Set here, not only in .env, so CI (which has no hand-written .env) gets it too.
    env: { DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX ?? "4" },
  },
});
