import type { ProductEvent } from "@scalecart/events";
import { prisma } from "./config/prisma.js";
import { publishStockChanged } from "./events/stock-changed.js";

/**
 * "product_sync" group: the service that owns products tells us about them.
 *   ProductCreated -> create the product's stock row (with the initial stock) + our copy of sku/name
 *   ProductUpdated -> refresh our copy of sku/name (shown in low-stock alerts)
 * Before M6.5 the product and its stock row were created in ONE transaction of ONE database.
 * Across two databases there is no shared transaction, so the stock row follows a moment later.
 * Both writes are idempotent (create-if-missing / upsert), so a redelivered event changes nothing.
 */
export async function productSyncHandler(e: ProductEvent) {
  const { productId, sku, name } = e.data;
  await prisma.productInfo.upsert({ where: { productId }, create: { productId, sku, name }, update: { sku, name } });
  if (e.type === "ProductCreated") {
    const created = await prisma.inventory.createMany({ data: [{ productId, available: e.data.initialStock }], skipDuplicates: true });
    // Let the owner's copy learn the row's version (0), so later changes are applied in order.
    if (created.count) await publishStockChanged([productId], "created");
  }
}
