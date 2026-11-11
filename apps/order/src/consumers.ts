import { consumerDef } from "@scalecart/events";

/** The consumer groups the ORDER service runs (handlers are loaded on the first event). */
export const consumers = [
  consumerDef("order", async () => (await import("./payment-results.handler.js")).paymentResultHandler),
  consumerDef("analytics", async () => (await import("./analytics.handler.js")).analyticsHandler),
];
