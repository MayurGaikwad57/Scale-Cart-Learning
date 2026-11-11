import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // M6: many tests now wait for asynchronous work crossing several services and the broker
    // (checkout -> OrderCreated -> payment -> OrderConfirmed -> inventory/notification).
    testTimeout: 20_000,
  },
});
