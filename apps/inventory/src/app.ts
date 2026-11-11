import { db, prisma } from "./config/prisma.js";
import { Router } from "express";
import { z } from "zod";
import { inventoryRouter } from "./modules/inventory/inventory.routes.js";
import { uuid } from "@scalecart/service-kit/validation";
import { requireInternal } from "@scalecart/service-kit/internal-auth";
import { createServiceApp } from "@scalecart/service-kit/service-app";
import { InsufficientStockError, ReservationReleasedError, reservations, reserveSchema } from "./reservations.js";

/**
 * INVENTORY SERVICE (:3003). Owns the stock numbers and the reservations.
 *   public   GET  /inventory/:productId, POST /inventory (admin sets stock)  - via the gateway
 *   internal POST /internal/reservations             reserve (called by the order service)
 *            POST /internal/reservations/:id/release give back (compensation)
 *            GET  /internal/reservations/:id         inspect
 *            GET  /internal/stock-alerts             low-stock alerts (the order service's admin page)
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

// Low-stock alerts for the admin "Events" page. Before M6.5 the order service read our stock_alerts
// table directly (one shared database); now it has to ASK - this is the only way in.
internal.get("/stock-alerts", async (_req, res) => {
  const alerts = await prisma.stockAlert.findMany({ orderBy: { available: "asc" } });
  const info = await prisma.productInfo.findMany({ where: { productId: { in: alerts.map((a) => a.productId) } } });
  const byId = new Map(info.map((i) => [i.productId, i]));
  res.json(
    alerts.map((a) => ({
      productId: a.productId,
      name: byId.get(a.productId)?.name ?? "(unknown product)",
      sku: byId.get(a.productId)?.sku ?? "",
      available: a.available,
      updatedAt: a.updatedAt,
    })),
  );
});

export const createInventoryApp = () =>
  createServiceApp("inventory", (app) => {
    app.use("/inventory", inventoryRouter);
    app.use("/internal", internal);
  }, { db });
