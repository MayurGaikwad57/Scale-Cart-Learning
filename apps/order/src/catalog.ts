import { HttpError } from "@scalecart/service-kit/errors";
import { callService } from "@scalecart/service-kit/http-client";

/**
 * What the order service needs to know about products - it ASKS the catalog service (its database
 * is not ours to read). One call for many products: never one HTTP call per cart line (N+1).
 */
export interface CatalogProduct {
  id: string;
  sku: string;
  name: string;
  category: string;
  priceCents: number;
  active: boolean;
  stock: number; // the catalog's copy of the inventory number - a HINT; checkout asks inventory itself
}

export const catalogUnavailable = () =>
  new HttpError(503, "catalog_unavailable", "We couldn't load product details right now (the catalog service is unavailable). Please try again in a moment.");

/** Product facts by id. Missing ids = products the catalog doesn't know (deleted). Throws 503 if it can't answer. */
export async function getProducts(ids: string[]): Promise<Map<string, CatalogProduct>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  let res;
  try {
    res = await callService<CatalogProduct[]>("catalog", "POST", "/internal/products/batch", { ids: unique }, { timeoutMs: 2000 });
  } catch {
    throw catalogUnavailable();
  }
  if (res.status !== 200) throw catalogUnavailable();
  return new Map(res.body.map((p) => [p.id, p]));
}
