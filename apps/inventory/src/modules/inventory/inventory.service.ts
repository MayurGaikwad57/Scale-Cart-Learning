import { z } from "zod";
import { prisma } from "../../config/prisma.js";
import { notFound } from "@scalecart/service-kit/errors";
import { publishStockChanged } from "../../events/stock-changed.js";
import { uuid } from "@scalecart/service-kit/validation";

export const setStockSchema = z.object({
  productId: uuid,
  available: z.number().int().min(0).max(1_000_000),
});

const dto = (i: { productId: string; available: number; reserved: number }) => ({
  productId: i.productId,
  available: i.available,
  reserved: i.reserved,
});

export const inventoryService = {
  async get(productId: string) {
    const row = await prisma.inventory.findUnique({ where: { productId } });
    if (!row) throw notFound("inventory_not_found");
    return dto(row);
  },

  // Admin sets the absolute sellable quantity. "reserved" is owned by the order flow, not touched here.
  async setStock(productId: string, available: number) {
    let row;
    try {
      row = await prisma.inventory.upsert({
        where: { productId },
        create: { productId, available },
        update: { available, version: { increment: 1 } },
      });
    } catch (err) {
      if ((err as { code?: string }).code === "P2003") throw notFound("product_not_found"); // FK violation
      throw err;
    }
    await publishStockChanged([productId], "admin"); // whoever shows stock refreshes (product + list pages)
    return dto(row);
  },
};
