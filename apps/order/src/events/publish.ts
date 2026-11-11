import { PRODUCTS_TOPIC, TOPIC_PARTITIONS, type OrderEvent, type PaymentEvent, type ProductEvent } from "@scalecart/events";
import { publish } from "@scalecart/service-kit/publisher";

/**
 * Publish an order/payment event. Key = orderId on BOTH topics, so all events of one order land
 * in the same partition, in order. (Dual-write caveats: see the kit's publish().)
 */
export const publishEvent = (topic: string, event: OrderEvent | PaymentEvent, mode: "best-effort" | "must" = "best-effort") =>
  publish({ topic, key: event.data.orderId, partitions: TOPIC_PARTITIONS, event, mode });

/** Product events (we own products until the catalog service exists). Key = productId. */
export const publishProductEvent = (event: ProductEvent) =>
  publish({ topic: PRODUCTS_TOPIC, key: event.data.productId, partitions: TOPIC_PARTITIONS, event });
