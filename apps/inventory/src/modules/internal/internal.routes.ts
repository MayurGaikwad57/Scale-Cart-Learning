import { Router } from "express";
import { z } from "zod";
import { requireInternal } from "@scalecart/service-kit/internal-auth";
import { uuid } from "@scalecart/service-kit/validation";
import { prisma } from "../../config/prisma.js";
import { InsufficientStockError, ReservationReleasedError, reservations, reserveSchema } from "../../reservations.js";

/**
 * The inventory service's INTERNAL API - for other services only (the gateway never forwards
 * /internal, and requireInternal checks the service token). Mounted at /internal in app.ts.
 *   POST /reservations               reserve (called by the order service's checkout)
 *   POST /reservations/:id/release   give back (compensation)
 *   GET  /reservations/:id           inspect
 *   GET  /stock-alerts               low-stock alerts (the order service's admin Events page)
 */
export const internalRouter = Router();
internalRouter.use(requireInternal);

internalRouter.post("/reservations", async (req, res) => {
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

internalRouter.post("/reservations/:orderId/release", async (req, res) => {
  const { orderId } = z.object({ orderId: uuid }).parse(req.params);
  res.json({ status: await reservations.release(orderId) });
});

internalRouter.get("/reservations/:orderId", async (req, res) => {
  const { orderId } = z.object({ orderId: uuid }).parse(req.params);
  const r = await reservations.get(orderId);
  if (!r) return res.status(404).json({ error: "reservation_not_found" });
  res.json({ orderId: r.orderId, status: r.status, items: r.items.map((i) => ({ productId: i.productId, quantity: i.quantity })) });
});

// Low-stock alerts for the admin "Events" page. The order service can't read our stock_alerts table
// (another database) - it has to ASK; this is the only way in.
internalRouter.get("/stock-alerts", async (_req, res) => {
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
