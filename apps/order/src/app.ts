import { createServiceApp } from "@scalecart/service-kit/service-app";
import { db } from "./config/prisma.js";
import { cartRouter } from "./modules/cart/cart.routes.js";
import { eventsRouter } from "./modules/events/events.routes.js";
import { internalRouter } from "./modules/internal/internal.routes.js";
import { ordersRouter } from "./modules/orders/orders.routes.js";

/**
 * ORDER SERVICE (:3001) - what is left of the M1-M5 monolith after extracting payment, inventory,
 * notification, identity and catalog. This is the STRANGLER FIG pattern: services are cut out of the
 * monolith one by one, behind a gateway, while everything keeps working - no big-bang rewrite.
 *
 * Still in here: cart, checkout (the saga), orders, the admin Events page and the analytics
 * projection, plus a small internal API for other services (modules/internal).
 *
 * This file only ASSEMBLES the service (the composition root): which features, at which prefix.
 * The endpoints themselves live in each feature's routes file.
 */
export const createOrderApp = () =>
  createServiceApp(
    "order",
    (app) => {
      app.use("/cart", cartRouter);
      app.use("/orders", ordersRouter);
      app.use("/admin/events", eventsRouter);
      app.use("/internal", internalRouter);
    },
    { db },
  );
