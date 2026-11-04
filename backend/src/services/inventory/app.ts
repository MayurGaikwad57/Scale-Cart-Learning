import { Router } from "express";
import { z } from "zod";
import { inventoryRouter } from "../../modules/inventory/inventory.routes.js";
import { uuid } from "../../utils/validation.js";
import { requireInternal } from "../shared/internal-auth.js";
import { createServiceApp } from "../shared/service-app.js";
import { InsufficientStockError, ReservationReleasedError, reservations, reserveSchema } from "./reservations.js";

/**
 * INVENTORY SERVICE (:3003). Owns the stock numbers and the reservations.
 *   public   GET  /inventory/:productId, POST /inventory (admin sets stock)  - via the gateway
 *   internal POST /internal/reservations             reserve (called by the order service)
 *            POST /internal/reservations/:id/release give back (compensation)
 *            GET  /internal/reservations/:id         inspect
 * Commit / release on the order's outcome arrive as EVENTS (inventory.handler.ts).
 *
 * WHY ITS OWN SERVICE: stock is the most CONTENDED data in the shop (every buyer of a hot product
 * locks the same row). Separating it lets it scale and be tuned on its own, and a slow catalog page
 * can no longer slow down reservations.
 */
const internal = Router();
internal.use(requireInternal);

internal.post("/reservations", async (req, res) => {
  const input = reserveSchema.parse(req.body);
  try {
    const result = await reservations.reserve(input);
    res.status(result.status === "reserved" ? 201 : 200).json(result);
  } catch (e) {
    if (e instanceof InsufficientStockError) {
      return res.status(409).json({ error: "insufficient_stock", productId: e.productId, available: e.available });
    }
    if (e instanceof ReservationReleasedError) return res.status(409).json({ error: "reservation_released" });
    throw e;
  }
});

internal.post("/reservations/:orderId/release", async (req, res) => {
  const { orderId } = z.object({ orderId: uuid }).parse(req.params);
  res.json({ status: await reservations.release(orderId) });
});

internal.get("/reservations/:orderId", async (req, res) => {
  const { orderId } = z.object({ orderId: uuid }).parse(req.params);
  const r = await reservations.get(orderId);
  if (!r) return res.status(404).json({ error: "reservation_not_found" });
  res.json({ orderId: r.orderId, status: r.status, items: r.items.map((i) => ({ productId: i.productId, quantity: i.quantity })) });
});

export const createInventoryApp = () =>
  createServiceApp("inventory", (app) => {
    app.use("/inventory", inventoryRouter);
    app.use("/internal", internal);
  });
