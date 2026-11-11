import { consumerDef } from "@scalecart/events";

/** The consumer groups the CATALOG service runs. */
export const consumers = [consumerDef("product_stock", async () => (await import("./product-stock.handler.js")).productStockHandler)];
