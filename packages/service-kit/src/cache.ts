import { kv } from "./kv.js";

/**
 * CACHE-ASIDE (a.k.a. lazy loading) - the app, not the cache, is in charge:
 *
 *   read:  look in ScaleKV -> HIT: return it
 *                          -> MISS: read PostgreSQL, store the result in ScaleKV with a TTL, return it
 *   write: update PostgreSQL FIRST, THEN delete/invalidate the cached copy
 *
 * The three classic cache failures and what this helper does about each:
 *  - STAMPEDE  (a hot key expires and 500 requests all hit the DB at once)
 *      -> "single-flight": concurrent misses for the same key in this process share ONE DB query.
 *  - AVALANCHE (thousands of keys created together expire together)
 *      -> TTL jitter: every TTL is randomly spread by ±10% so expiries are smeared out.
 *  - PENETRATION (requests for ids that don't exist always miss and always hit the DB)
 *      -> negative caching: "not found" is cached too, briefly.
 *
 * If ScaleKV is down we just call the loader: slower, but correct ("BYPASS").
 */

export type CacheStatus = "HIT" | "MISS" | "BYPASS";
export interface Cached<T> {
  data: T;
  cache: CacheStatus;
}

const NULL_MARKER = "__null__";

/**
 * The CACHE's own hit rate, counted here in the API (per process). ScaleKV's keyspace_hits /
 * keyspace_misses are NOT the same thing: they count every GET of every key, including the
 * rate limiter reading an empty "previous minute" counter - which would look like a cache miss.
 */
export const cacheStats = { hits: 0, misses: 0, bypass: 0 };
const count = <T>(r: Cached<T>): Cached<T> => {
  if (r.cache === "HIT") cacheStats.hits++;
  else if (r.cache === "MISS") cacheStats.misses++;
  else cacheStats.bypass++;
  return r;
};
const inflight = new Map<string, Promise<unknown>>();

const jitter = (ms: number) => Math.round(ms * (0.9 + Math.random() * 0.2));

export async function cached<T>(
  key: string,
  opts: { ttlMs: number; negativeTtlMs?: number },
  load: () => Promise<T | null>,
): Promise<Cached<T | null>> {
  return count(await cachedUncounted(key, opts, load));
}

/** Count a read that skipped the cache entirely (e.g. admin reads, ScaleKV unreachable). */
export const countBypass = () => void cacheStats.bypass++;

async function cachedUncounted<T>(
  key: string,
  opts: { ttlMs: number; negativeTtlMs?: number },
  load: () => Promise<T | null>,
): Promise<Cached<T | null>> {
  if (!kv.isReady) return { data: await load(), cache: "BYPASS" };

  try {
    const hit = await kv.get(key);
    if (hit !== null) return { data: hit === NULL_MARKER ? null : (JSON.parse(hit) as T), cache: "HIT" };
  } catch {
    return { data: await load(), cache: "BYPASS" }; // timed out / dropped: don't wait on the cache again
  }

  // Single-flight: if another request in this process is already loading this key, wait for it.
  let loading = inflight.get(key) as Promise<T | null> | undefined;
  if (!loading) {
    loading = load().finally(() => inflight.delete(key));
    inflight.set(key, loading);
    const data = await loading;
    const ttl = data === null ? (opts.negativeTtlMs ?? 0) : opts.ttlMs;
    if (ttl > 0) {
      // Fire-and-forget: a failed cache write must not fail (or slow down) the request.
      kv.set(key, data === null ? NULL_MARKER : JSON.stringify(data), { pxMs: jitter(ttl) }).catch(() => undefined);
    }
    return { data, cache: "MISS" };
  }
  return { data: await loading, cache: "MISS" };
}

/** Delete keys; never throws. If ScaleKV is unreachable the entries simply live until their TTL. */
export async function invalidate(...keys: string[]) {
  if (!keys.length || !kv.isReady) return;
  await kv.del(...keys).catch(() => undefined);
}
