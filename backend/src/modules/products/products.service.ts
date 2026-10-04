import { conflict, notFound } from "../../utils/errors.js";
import { productsRepository } from "./products.repository.js";
import type { CreateProductInput, ListQuery, UpdateProductInput } from "./products.validation.js";

type ProductRow = NonNullable<Awaited<ReturnType<typeof productsRepository.findById>>>;

// The shape the API returns (inventory flattened into "stock").
export const toProductDto = ({ inventory, ...p }: ProductRow) => ({
  ...p,
  stock: inventory?.available ?? 0,
});

const isCode = (err: unknown, code: string) => (err as { code?: string }).code === code;

export const productsService = {
  async list(q: ListQuery, isAdmin: boolean) {
    const { items, total } = await productsRepository.list(q, isAdmin && q.includeInactive);
    return { items: items.map(toProductDto), total, page: q.page, pageSize: q.pageSize };
  },

  async get(id: string, isAdmin: boolean) {
    const product = await productsRepository.findById(id);
    // Inactive (deleted) products look like they don't exist to everyone except admins.
    if (!product || (!product.active && !isAdmin)) throw notFound("product_not_found");
    return toProductDto(product);
  },

  categories: () => productsRepository.categories(),

  async create(input: CreateProductInput) {
    try {
      return toProductDto(await productsRepository.create(input));
    } catch (err) {
      if (isCode(err, "P2002")) throw conflict("sku_taken");
      throw err;
    }
  },

  async update(id: string, input: UpdateProductInput) {
    try {
      return toProductDto(await productsRepository.update(id, input));
    } catch (err) {
      if (isCode(err, "P2025")) throw notFound("product_not_found");
      if (isCode(err, "P2002")) throw conflict("sku_taken");
      throw err;
    }
  },

  // Soft delete: orders reference products through foreign keys and must stay readable.
  async remove(id: string) {
    await productsService.update(id, { active: false });
  },
};
