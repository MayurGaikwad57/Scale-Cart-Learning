import { cached, countBypass, type Cached } from "@scalecart/service-kit/cache";
import { conflict, notFound } from "@scalecart/service-kit/errors";
import {
  CATEGORIES_TTL_MS,
  catalogVersion,
  invalidateProducts,
  LIST_TTL_MS,
  NOT_FOUND_TTL_MS,
  PRODUCT_TTL_MS,
  productKeys,
  productVersion,
} from "./products.cache.js";
import { productsRepository } from "./products.repository.js";
import type { CreateProductInput, ListQuery, UpdateProductInput } from "./products.validation.js";

type ProductRow = NonNullable<Awaited<ReturnType<typeof productsRepository.findById>>>;

// The shape the API returns (inventory flattened into "stock").
export const toProductDto = ({ inventory, ...p }: ProductRow) => ({
  ...p,
  stock: inventory?.available ?? 0,
});
export type ProductDto = ReturnType<typeof toProductDto>;

const isCode = (err: unknown, code: string) => (err as { code?: string }).code === code;

export const productsService = {
  // Reads go through the cache (cache-aside). Admins always read live data: they are the ones
  // editing products and must see their change immediately (and they can see inactive products).
  async list(q: ListQuery, isAdmin: boolean): Promise<Cached<{ items: ProductDto[]; total: number; page: number; pageSize: number }>> {
    const load = async () => {
      const { items, total } = await productsRepository.list(q, isAdmin && q.includeInactive);
      return { items: items.map(toProductDto), total, page: q.page, pageSize: q.pageSize };
    };
    const ver = isAdmin ? null : await catalogVersion();
    if (ver === null) {
      countBypass();
      return { data: await load(), cache: "BYPASS" };
    }
    const r = await cached(productKeys.list(ver, q), { ttlMs: LIST_TTL_MS }, load);
    return { data: r.data!, cache: r.cache };
  },

  async get(id: string, isAdmin: boolean): Promise<Cached<ProductDto>> {
    // The cached value is the product as stored, INCLUDING inactive ones, so one cache entry
    // serves admins and customers; the visibility rule is applied after the cache.
    // A product id that doesn't exist is cached as "null" for 15s (cache penetration guard).
    const load = async () => {
      const row = await productsRepository.findById(id);
      return row ? toProductDto(row) : null;
    };
    const ver = await productVersion(id);
    let r: Cached<ProductDto | null>;
    if (ver === null) {
      countBypass();
      r = { data: await load(), cache: "BYPASS" };
    } else {
      r = await cached(productKeys.detail(id, ver), { ttlMs: PRODUCT_TTL_MS, negativeTtlMs: NOT_FOUND_TTL_MS }, load);
    }
    // Inactive (deleted) products look like they don't exist to everyone except admins.
    if (!r.data || (!r.data.active && !isAdmin)) throw notFound("product_not_found");
    return { data: r.data, cache: r.cache };
  },

  async categories(): Promise<Cached<string[]>> {
    const ver = await catalogVersion();
    if (ver === null) {
      countBypass();
      return { data: await productsRepository.categories(), cache: "BYPASS" };
    }
    const r = await cached(productKeys.categories(ver), { ttlMs: CATEGORIES_TTL_MS }, productsRepository.categories);
    return { data: r.data!, cache: r.cache };
  },

  async create(input: CreateProductInput) {
    try {
      const product = toProductDto(await productsRepository.create(input));
      await invalidateProducts([product.id], { catalog: true }); // must appear in lists/categories
      return product;
    } catch (err) {
      if (isCode(err, "P2002")) throw conflict("sku_taken");
      throw err;
    }
  },

  async update(id: string, input: UpdateProductInput) {
    let product: ProductDto;
    try {
      product = toProductDto(await productsRepository.update(id, input));
    } catch (err) {
      if (isCode(err, "P2025")) throw notFound("product_not_found");
      if (isCode(err, "P2002")) throw conflict("sku_taken");
      throw err;
    }
    // Database first, cache second (see products.cache.ts).
    await invalidateProducts([id], { catalog: true });
    return product;
  },

  // Soft delete: orders reference products through foreign keys and must stay readable.
  async remove(id: string) {
    await productsService.update(id, { active: false });
  },
};
