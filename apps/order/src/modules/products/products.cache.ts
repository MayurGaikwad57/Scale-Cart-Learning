import { createHash } from "node:crypto";
import { kv } from "@scalecart/service-kit/kv";
import type { ListQuery } from "./products.validation.js";

/**
 * Cache layout for the catalog (all in ScaleKV):
 *
 *   product:<id>:v<pver>                 one product (detail page)              TTL 60s
 *   product:ver:<id>                     that product's version (a counter, no TTL)
 *   products:list:v<ver>:<hash of query> one catalog page for one filter combo  TTL 30s
 *   products:categories:v<ver>           category list                          TTL 5min
 *   products:ver                         the current "version" of the catalog (a counter)
 *
 * WHY THE VERSION NUMBER: when a product changes, which cached list pages contain it? We can't
 * know - there is one page per (search, category, price range, sort, page) combination. Scanning
 * all keys (KEYS products:list:*) is O(N) and blocks ScaleKV. Instead we INCR products:ver: every
 * reader now builds keys with the new version, so all old pages become unreachable at once and
 * quietly expire through their TTL. One O(1) command invalidates thousands of entries.
 *
 * Product DETAIL keys are versioned per product for a second reason - a race that plain
 * "DEL after commit" cannot fix:
 *     reader: cache miss -> reads OLD row from Postgres ............ -> SET product:<id> OLD
 *     writer:                        commit NEW row -> DEL product:<id>
 * The reader's SET lands after the DEL, so the old row is cached for a full TTL. With versions
 * the reader writes to product:<id>:v4 while everyone now reads product:<id>:v5 - the stale
 * copy is unreachable. (Version counters are protected from LRU eviction in ScaleKV.)
 */
export const PRODUCT_TTL_MS = 60_000;
export const LIST_TTL_MS = 30_000;
export const CATEGORIES_TTL_MS = 300_000;
export const NOT_FOUND_TTL_MS = 15_000;

const VERSION_KEY = "products:ver";
const hash = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 16);

export const productKeys = {
  detail: (id: string, ver: string) => `product:${id}:v${ver}`,
  detailVersion: (id: string) => `product:ver:${id}`,
  list: (ver: string, q: ListQuery) => `products:list:v${ver}:${hash(q)}`,
  categories: (ver: string) => `products:categories:v${ver}`,
};

/** A version counter's value ("0" if never bumped), or null when ScaleKV can't tell us (-> skip the cache). */
async function readVersion(key: string): Promise<string | null> {
  if (!kv.isReady) return null;
  try {
    return (await kv.get(key)) ?? "0";
  } catch {
    return null;
  }
}
export const catalogVersion = () => readVersion(VERSION_KEY);
export const productVersion = (id: string) => readVersion(productKeys.detailVersion(id));

/**
 * Call AFTER the database change is committed. (Invalidate before commit and a reader could
 * re-cache the old row in between.)
 *
 * `catalog: true` also retires every cached list page + categories. Admin changes do that.
 * Checkout does NOT: at one order per second it would wipe the whole list cache every second
 * (hit rate ~0). Trade-off we accept: the stock number on a catalog LIST page may lag by up to
 * its 30s TTL after a sale. The product page itself is exact, and checkout re-checks real stock
 * under row locks, so nobody can ever buy stock that isn't there.
 */
export async function invalidateProducts(productIds: string[], opts: { catalog: boolean }) {
  if (!kv.isReady) return;
  await Promise.all([
    ...productIds.map((id) => kv.incr(productKeys.detailVersion(id)).catch(() => undefined)),
    opts.catalog ? kv.incr(VERSION_KEY).catch(() => undefined) : undefined,
  ]);
}
