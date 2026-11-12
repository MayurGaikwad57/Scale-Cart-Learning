import { createServiceApp } from "@scalecart/service-kit/service-app";
import { db } from "./config/prisma.js";
import { internalRouter } from "./modules/internal/internal.routes.js";
import { inventoryRouter } from "./modules/inventory/inventory.routes.js";

/**
 * INVENTORY SERVICE (:3003). Owns the stock numbers and the reservations.
 *   public   GET  /inventory/:productId, POST /inventory (admin sets stock)  - via the gateway
 *   internal /internal/...  reservations + stock alerts, for other services (modules/internal)
 * Commit / release on the order's outcome arrive as EVENTS (inventory.handler.ts).
 *
 * WHY ITS OWN SERVICE: stock is the most CONTENDED data in the shop (every buyer of a hot product
 * locks the same row). Separating it lets it scale and be tuned on its own, and a slow catalog page
 * can no longer slow down reservations.
 *
 * This file only ASSEMBLES the service (the composition root): which features, at which prefix.
 * The endpoints themselves live in each feature's routes file.
 */
export const createInventoryApp = () =>
  createServiceApp(
    "inventory",
    (app) => {
      app.use("/inventory", inventoryRouter);
      app.use("/internal", internalRouter);
    },
    { db },
  );
