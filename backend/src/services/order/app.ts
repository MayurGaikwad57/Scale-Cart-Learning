import { cartRouter } from "../../modules/cart/cart.routes.js";
import { eventsRouter } from "../../modules/events/events.routes.js";
import { ordersRouter } from "../../modules/orders/orders.routes.js";
import { productsRouter } from "../../modules/products/products.routes.js";
import { systemRouter } from "../../modules/system/system.routes.js";
import { authRouter } from "../../modules/users/users.routes.js";
import { createServiceApp } from "../shared/service-app.js";

/**
 * ORDER SERVICE (:3001) - what is left of the M1-M5 monolith after extracting payment, inventory
 * and notification. This is the STRANGLER FIG pattern: services are cut out of the monolith one by
 * one, behind a gateway, while everything keeps working - no big-bang rewrite.
 *
 * Still in here: users/auth, product catalog, cart, orders, admin (system + events pages) and the
 * analytics projection. In a bigger system "catalog" and "users" would be the next extractions.
 */
export const createOrderApp = () =>
  createServiceApp("order", (app) => {
    app.use("/auth", authRouter);
    app.use("/products", productsRouter);
    app.use("/cart", cartRouter);
    app.use("/orders", ordersRouter);
    app.use("/admin/system", systemRouter);
    app.use("/admin/events", eventsRouter);
  });
