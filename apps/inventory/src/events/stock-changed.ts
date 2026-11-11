import { INVENTORY_TOPIC, makeEvent, TOPIC_PARTITIONS, type StockChanged, type StockChangedData } from "@scalecart/events";
import { publish } from "@scalecart/service-kit/publisher";
import { prisma } from "../config/prisma.js";

/**
 * Tell everyone who shows stock that it changed, WITH the new number and the row's version, so
 * they can keep their own copy (they can't read our database). Call it AFTER the change committed.
 * One event per product, key = productId -> per-product order on the "inventory" topic.
 *
 * Best effort: if one is lost, a product page shows an old number until the next change of that
 * product - the stock itself is always correct HERE, and the checkout always asks us. (M7's
 * outbox makes publishing reliable.)
 */
export async function publishStockChanged(productIds: string[], cause: StockChangedData["cause"]) {
  const ids = [...new Set(productIds)];
  if (!ids.length) return;
  const rows = await prisma.inventory.findMany({ where: { productId: { in: ids } }, select: { productId: true, available: true, version: true } });
  await Promise.all(
    rows.map((r) =>
      publish({
        topic: INVENTORY_TOPIC,
        key: r.productId,
        partitions: TOPIC_PARTITIONS,
        event: makeEvent<StockChanged>("StockChanged", 2, { productId: r.productId, cause, available: r.available, version: r.version }),
      }),
    ),
  );
}
