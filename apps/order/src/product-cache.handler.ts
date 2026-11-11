import type { InventoryEvent } from "@scalecart/events";
import { invalidateProducts } from "./modules/products/products.cache.js";

/**
 * "product_cache" group: the inventory service tells us that stock changed; the product pages we
 * cache show stock, so we refresh them. Invalidation is idempotent - a duplicate event just bumps
 * the version once more (one extra cache miss), so no once() is needed.
 *   reservation -> only that product's page (list pages keep their cache: hit rate survives)
 *   admin       -> also the list pages (an admin stock change should show everywhere at once)
 */
export async function productCacheHandler(e: InventoryEvent) {
  if (e.type !== "StockChanged") return "skipped";
  await invalidateProducts([e.data.productId], { catalog: e.data.cause === "admin" });
}
