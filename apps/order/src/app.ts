import { cartRouter } from "./modules/cart/cart.routes.js";
import { eventsRouter } from "./modules/events/events.routes.js";
import { ordersRouter } from "./modules/orders/orders.routes.js";
import { productsRouter } from "./modules/products/products.routes.js";
import { systemRouter } from "./modules/system/system.routes.js";
import { Router } from "express";
import { z } from "zod";
import { db, prisma } from "./config/prisma.js";
import { uuid } from "@scalecart/service-kit/validation";
import { requireInternal } from "@scalecart/service-kit/internal-auth";
import { createServiceApp } from "@scalecart/service-kit/service-app";

/**
 * Internal API for other services. The inventory service's SWEEPER asks "what happened to this
 * order?" for reservations that have been HELD too long (inventory/sweeper.ts).
 */
const internal = Router();
internal.use(requireInternal);
internal.get("/orders/:id/status", async (req, res) => {
  const { id } = z.object({ id: uuid }).parse(req.params);
  const order = await prisma.order.findUnique({ where: { id }, select: { status: true } });
  if (!order) return res.status(404).json({ error: "order_not_found" });
  res.json({ status: order.status });
});

/**
 * ORDER SERVICE (:3001) - what is left of the M1-M5 monolith after extracting payment, inventory
 * and notification. This is the STRANGLER FIG pattern: services are cut out of the monolith one by
 * one, behind a gateway, while everything keeps working - no big-bang rewrite.
 *
 * Still in here: product catalog, cart, orders, admin (system + events pages) and the
 * analytics projection. In a bigger system "catalog" and "users" would be the next extractions.
 */
export const createOrderApp = () =>
  createServiceApp("order", (app) => {
    app.use("/products", productsRouter);
    app.use("/cart", cartRouter);
    app.use("/orders", ordersRouter);
    app.use("/admin/system", systemRouter);
    app.use("/admin/events", eventsRouter);
    app.use("/internal", internal);
  }, { db });
