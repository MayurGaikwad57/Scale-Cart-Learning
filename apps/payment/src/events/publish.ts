import { TOPIC_PARTITIONS, type OrderEvent, type PaymentEvent } from "@scalecart/events";
import { publish } from "@scalecart/service-kit/publisher";

/**
 * Publish an order/payment event. Key = orderId on BOTH topics, so all events of one order land
 * in the same partition, in order. (Dual-write caveats: see the kit's publish().)
 */
export const publishEvent = (topic: string, event: OrderEvent | PaymentEvent, mode: "best-effort" | "must" = "best-effort") =>
  publish({ topic, key: event.data.orderId, partitions: TOPIC_PARTITIONS, event, mode });
