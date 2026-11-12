import { Router } from "express";
import { z } from "zod";
import { requireInternal } from "@scalecart/service-kit/internal-auth";
import { uuid } from "@scalecart/service-kit/validation";
import { prisma } from "../../config/prisma.js";

/**
 * The catalog service's INTERNAL API - for other services only (the gateway never forwards
 * /internal, and requireInternal checks the service token). Mounted at /internal in app.ts.
 *   POST /products/batch   facts about several products at once (the order service: cart page,
 *                          add to cart, and the PRICE SNAPSHOT at checkout) - one call, never N+1
 */
const MAX_BATCH = 100;

export const internalRouter = Router();
internalRouter.use(requireInternal);

internalRouter.post("/products/batch", async (req, res) => {
  const { ids } = z.object({ ids: z.array(uuid).max(MAX_BATCH) }).parse(req.body);
  const rows = await prisma.product.findMany({ where: { id: { in: ids } } });
  // Unknown ids are simply missing from the answer; the caller decides what that means.
  res.json(
    rows.map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      priceCents: p.priceCents,
      active: p.active,
      stock: p.stockAvailable,
    })),
  );
});
