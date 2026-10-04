import { z } from "zod";
import { pageParams } from "../../utils/validation.js";

// Prices are integer cents everywhere (query string included): minPrice=1000 means 10.00.
export const listQuerySchema = z.object({
  ...pageParams,
  q: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  sort: z.enum(["newest", "price_asc", "price_desc", "name"]).default("newest"),
  includeInactive: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
});

const base = {
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(""),
  priceCents: z.number().int().min(0).max(100_000_000),
  category: z.string().trim().min(1).max(64),
  active: z.boolean().default(true),
};

export const createProductSchema = z.object({
  ...base,
  stock: z.number().int().min(0).max(1_000_000).default(0),
});

// PUT with partial fields. Stock is changed through /inventory, not here.
export const updateProductSchema = z.object(base).partial();

export type ListQuery = z.infer<typeof listQuerySchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
