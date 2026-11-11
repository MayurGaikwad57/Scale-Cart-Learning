import { INVENTORY_TOPIC, makeEvent, TOPIC_PARTITIONS, type StockChanged, type StockChangedData } from "@scalecart/events";
import { publish } from "@scalecart/service-kit/publisher";

/**
 * Tell everyone who shows stock (today: the order service's cached product pages) that it changed.
 * One event per product, key = productId -> per-product order on the "inventory" topic.
 * Best effort: losing one only means a product page shows old stock until its cache expires
 * (at most 60 s) - the stock itself is always correct in OUR database. (M7's outbox makes it reliable.)
 */
export async function publishStockChanged(productIds: string[], cause: StockChangedData["cause"]) {
  await Promise.all(
    [...new Set(productIds)].map((productId) =>
      publish({
        topic: INVENTORY_TOPIC,
        key: productId,
        partitions: TOPIC_PARTITIONS,
        event: makeEvent<StockChanged>("StockChanged", 1, { productId, cause }),
      }),
    ),
  );
}
