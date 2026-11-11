import { consumerDef } from "@scalecart/events";

/** The consumer groups the INVENTORY service runs. */
export const consumers = [consumerDef("inventory", async () => (await import("./inventory.handler.js")).inventoryHandler)];
