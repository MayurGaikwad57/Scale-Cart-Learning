import type { InventoryEvent } from "@scalecart/events";
import { prisma } from "./config/prisma.js";
import { invalidateProducts } from "./modules/products/products.cache.js";

/**
 * "product_stock" group: the inventory service tells us that a product's stock changed.
 *   1. update OUR COPY of the number (products.stock_available) - we can't read its database;
 *   2. refresh the cached product pages that show it.
 *
 * VERSIONED UPDATE: the event carries the inventory row's version, and we apply it only if it is
 * NEWER than the version we have ("stock_version < version"). Events for one product arrive in order
 * (same key = same partition), but a redelivery or a replay can bring an OLD one back - it must never
 * overwrite a newer number. That makes this handler idempotent without once().
 *   reservation -> only that product's page (list pages keep their cache: hit rate survives)
 *   admin       -> also the list pages (an admin stock change should show everywhere at once)
 */
export async function productStockHandler(e: InventoryEvent) {
  if (e.type !== "StockChanged") return "skipped";
  const { productId, available, version, cause } = e.data;
  if (available !== undefined && version !== undefined) {
    const updated = await prisma.product.updateMany({
      where: { id: productId, stockVersion: { lt: version } },
      data: { stockAvailable: available, stockVersion: version },
    });
    if (updated.count === 0) return "stale"; // we already have this version or a newer one
  }
  await invalidateProducts([productId], { catalog: cause === "admin" });
}
