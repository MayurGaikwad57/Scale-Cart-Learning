import { createHash } from "node:crypto";
import { kv } from "../../config/kv.js";
import { invalidate } from "../../lib/cache.js";
import type { ListQuery } from "./products.validation.js";

/**
 * Cache layout for the catalog (all in ScaleKV):
 *
 *   product:<id>                         one product (detail page)              TTL 60s
 *   products:list:v<ver>:<hash of query> one catalog page for one filter combo  TTL 30s
 *   products:categories:v<ver>           category list                          TTL 5min
 *   products:ver                         the current "version" of the catalog (a counter)
 *
 * WHY THE VERSION NUMBER: when a product changes, which cached list pages contain it? We can't
 * know - there is one page per (search, category, price range, sort, page) combination. Scanning
 * all keys (KEYS products:list:*) is O(N) and blocks ScaleKV. Instead we INCR products:ver: every
 * reader now builds keys with the new version, so all old pages become unreachable at once and
 * quietly expire through their TTL. One O(1) command invalidates thousands of entries.
 */
export const PRODUCT_TTL_MS = 60_000;
export const LIST_TTL_MS = 30_000;
export const CATEGORIES_TTL_MS = 300_000;
export const NOT_FOUND_TTL_MS = 15_000;

const VERSION_KEY = "products:ver";
const hash = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 16);

export const productKeys = {
  detail: (id: string) => `product:${id}`,
  list: (ver: string, q: ListQuery) => `products:list:v${ver}:${hash(q)}`,
  categories: (ver: string) => `products:categories:v${ver}`,
};

/** Current catalog version, or null when ScaleKV can't tell us (then the caller skips the cache). */
export async function catalogVersion(): Promise<string | null> {
  if (!kv.isReady) return null;
  try {
    return (await kv.get(VERSION_KEY)) ?? "0";
  } catch {
    return null;
  }
}

/**
 * Call AFTER the database change is committed. (Invalidate before commit and a reader could
 * re-cache the old row in between.) Used by product edits, admin stock changes and checkout.
 */
export async function invalidateProducts(productIds: string[]) {
  if (!kv.isReady) return;
  await Promise.all([
    invalidate(...productIds.map(productKeys.detail)),
    kv.incr(VERSION_KEY).catch(() => undefined),
  ]);
}
