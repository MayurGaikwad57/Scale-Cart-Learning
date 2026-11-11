import { consumerDef } from "@scalecart/events";

/** The consumer groups the PAYMENT service runs. */
export const consumers = [consumerDef("payment", async () => (await import("./payment.handler.js")).paymentHandler)];
