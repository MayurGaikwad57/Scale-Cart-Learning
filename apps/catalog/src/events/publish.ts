import { PRODUCTS_TOPIC, TOPIC_PARTITIONS, type ProductEvent } from "@scalecart/events";
import { publish } from "@scalecart/service-kit/publisher";

/** Product events - we OWN the products. Key = productId (per-product order on the "products" topic). */
export const publishProductEvent = (event: ProductEvent) =>
  publish({ topic: PRODUCTS_TOPIC, key: event.data.productId, partitions: TOPIC_PARTITIONS, event });
