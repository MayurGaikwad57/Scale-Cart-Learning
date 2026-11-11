import { Router } from "express";
import { z } from "zod";
import { requireInternal } from "@scalecart/service-kit/internal-auth";
import { createServiceApp } from "@scalecart/service-kit/service-app";
import { uuid } from "@scalecart/service-kit/validation";
import { db, prisma } from "./config/prisma.js";
import { productsRouter } from "./modules/products/products.routes.js";
import { systemRouter } from "./modules/system/system.routes.js";

/**
 * CATALOG SERVICE (:3006) - what can be bought, at what price. Owns the products (its own database)
 * and the product cache in ScaleKV.
 *   public   GET /products (search, filter, sort, paginate), GET /products/:id, GET /products/categories,
 *            admin POST/PUT/DELETE /products                                         - via the gateway
 *            GET /admin/system   ScaleKV + product-cache status (the cache lives here)
 *   internal POST /internal/products/batch   facts about several products at once (the order service:
 *            cart page, add to cart, and the PRICE SNAPSHOT at checkout)
 *   events   publishes ProductCreated / ProductUpdated; consumes StockChanged (its copy of the stock)
 *
 * WHY ITS OWN SERVICE: the catalog is READ-HEAVY (every visitor browses, few buy) while orders are
 * WRITE-HEAVY and transactional. Separated, the catalog can be scaled out and cached aggressively
 * without touching the checkout path. It is the classic first extraction in e-commerce.
 */
const MAX_BATCH = 100;
const internal = Router();
internal.use(requireInternal);

internal.post("/products/batch", async (req, res) => {
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

export const createCatalogApp = () =>
  createServiceApp(
    "catalog",
    (app) => {
      app.use("/products", productsRouter);
      app.use("/admin/system", systemRouter);
      app.use("/internal", internal);
    },
    { db },
  );
