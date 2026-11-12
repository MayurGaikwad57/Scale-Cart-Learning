import { createServiceApp } from "@scalecart/service-kit/service-app";
import { db } from "./config/prisma.js";
import { internalRouter } from "./modules/internal/internal.routes.js";
import { productsRouter } from "./modules/products/products.routes.js";
import { systemRouter } from "./modules/system/system.routes.js";

/**
 * CATALOG SERVICE (:3006) - what can be bought, at what price. Owns the products (its own database)
 * and the product cache in ScaleKV.
 *   public   GET /products (search, filter, sort, paginate), GET /products/:id, GET /products/categories,
 *            admin POST/PUT/DELETE /products                                         - via the gateway
 *            GET /admin/system   ScaleKV + product-cache status (the cache lives here)
 *   internal /internal/products/batch  for the order service (modules/internal)
 *   events   publishes ProductCreated / ProductUpdated; consumes StockChanged (its copy of the stock)
 *
 * WHY ITS OWN SERVICE: the catalog is READ-HEAVY (every visitor browses, few buy) while orders are
 * WRITE-HEAVY and transactional. Separated, the catalog can be scaled out and cached aggressively
 * without touching the checkout path. It is the classic first extraction in e-commerce.
 *
 * This file only ASSEMBLES the service (the composition root): which features, at which prefix.
 * The endpoints themselves live in each feature's routes file.
 */
export const createCatalogApp = () =>
  createServiceApp(
    "catalog",
    (app) => {
      app.use("/products", productsRouter);
      app.use("/admin/system", systemRouter);
      app.use("/internal", internalRouter);
    },
    { db },
  );
