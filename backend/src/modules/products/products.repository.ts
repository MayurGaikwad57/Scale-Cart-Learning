import { Prisma } from "../../../generated/prisma/client.js";
import { prisma } from "../../config/prisma.js";
import type { CreateProductInput, ListQuery, UpdateProductInput } from "./products.validation.js";

const withStock = { inventory: { select: { available: true } } } as const;

const orderBy = (sort: ListQuery["sort"]): Prisma.ProductOrderByWithRelationInput[] => {
  switch (sort) {
    case "price_asc":
      return [{ priceCents: "asc" }, { id: "asc" }];
    case "price_desc":
      return [{ priceCents: "desc" }, { id: "asc" }];
    case "name":
      return [{ name: "asc" }, { id: "asc" }];
    default:
      // id as a tie-breaker keeps pagination stable when sort values are equal.
      return [{ createdAt: "desc" }, { id: "asc" }];
  }
};

function where(q: ListQuery, includeInactive: boolean): Prisma.ProductWhereInput {
  const price: Prisma.IntFilter = {};
  if (q.minPrice !== undefined) price.gte = q.minPrice;
  if (q.maxPrice !== undefined) price.lte = q.maxPrice;
  return {
    ...(includeInactive ? {} : { active: true }),
    ...(q.category ? { category: q.category } : {}),
    ...(Object.keys(price).length ? { priceCents: price } : {}),
    ...(q.q
      ? {
          OR: [
            { name: { contains: q.q, mode: "insensitive" } },
            { description: { contains: q.q, mode: "insensitive" } },
            { sku: { contains: q.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
}

export const productsRepository = {
  async list(q: ListQuery, includeInactive: boolean) {
    const w = where(q, includeInactive);
    // One round trip: the page and the total count for the pager.
    const [items, total] = await prisma.$transaction([
      prisma.product.findMany({
        where: w,
        orderBy: orderBy(q.sort),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: withStock,
      }),
      prisma.product.count({ where: w }),
    ]);
    return { items, total };
  },

  findById: (id: string) => prisma.product.findUnique({ where: { id }, include: withStock }),

  async categories() {
    const rows = await prisma.product.findMany({
      where: { active: true },
      distinct: ["category"],
      select: { category: true },
      orderBy: { category: "asc" },
    });
    return rows.map((r) => r.category);
  },

  // Product + its inventory row are created together, so every product always has stock info.
  create: ({ stock, ...data }: CreateProductInput) =>
    prisma.product.create({
      data: { ...data, inventory: { create: { available: stock } } },
      include: withStock,
    }),

  update: (id: string, data: UpdateProductInput) =>
    prisma.product.update({ where: { id }, data, include: withStock }),
};
