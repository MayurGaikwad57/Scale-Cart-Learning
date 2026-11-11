import { Router } from "express";
import { kv } from "@scalecart/service-kit/kv";
import { cacheStats } from "@scalecart/service-kit/cache";
import { authenticate, requireRole } from "@scalecart/service-kit/auth";
import { rules } from "@scalecart/service-kit/rate-limit";
import { CATEGORIES_TTL_MS, LIST_TTL_MS, NOT_FOUND_TTL_MS, PRODUCT_TTL_MS } from "../products/products.cache.js";

// Admin-only look under the hood: is ScaleKV up, and how well is the cache doing?
export const systemRouter = Router();
systemRouter.use(authenticate, requireRole("ADMIN"));

systemRouter.get("/", async (_req, res) => {
  let info: Record<string, string> | null = null;
  if (kv.isReady) info = await kv.info().catch(() => null);
  const num = (k: string) => (info?.[k] !== undefined ? Number(info[k]) : null);
  res.json({
    kv: {
      status: kv.status,
      url: kv.url ?? null,
      stats: info && {
        uptimeSeconds: num("uptime_seconds"),
        connectedClients: num("connected_clients"),
        keys: num("keys"),
        keysWithTtl: num("keys_with_ttl"),
        maxKeys: num("max_keys"),
        commandsProcessed: num("total_commands_processed"),
        hits: num("keyspace_hits"),
        misses: num("keyspace_misses"),
        hitRatePercent: num("hit_rate_percent"),
        expiredKeys: num("expired_keys"),
        evictedKeys: num("evicted_keys"),
        memoryBytes: num("used_memory_rss_bytes"),
      },
    },
    cache: {
      // Counted by this API process since it started (see lib/cache.ts for why not ScaleKV's numbers).
      hits: cacheStats.hits,
      misses: cacheStats.misses,
      bypass: cacheStats.bypass,
      hitRatePercent: cacheStats.hits + cacheStats.misses ? Math.round((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 1000) / 10 : 0,
      productTtlSeconds: PRODUCT_TTL_MS / 1000,
      listTtlSeconds: LIST_TTL_MS / 1000,
      categoriesTtlSeconds: CATEGORIES_TTL_MS / 1000,
      notFoundTtlSeconds: NOT_FOUND_TTL_MS / 1000,
    },
    rateLimits: Object.values(rules).map((r) => ({
      name: r.name,
      limit: r.limit,
      window: r.windowMs === 60_000 ? "1 minute" : `${r.windowMs / 1000} seconds`,
      per: r.per,
      appliesTo: r.appliesTo,
    })),
  });
});
