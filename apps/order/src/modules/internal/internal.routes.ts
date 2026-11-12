import { Router } from "express";
import { z } from "zod";
import { requireInternal } from "@scalecart/service-kit/internal-auth";
import { uuid } from "@scalecart/service-kit/validation";
import { prisma } from "../../config/prisma.js";

/**
 * The order service's INTERNAL API - for other services only (the gateway never forwards
 * /internal, and requireInternal checks the service token). Mounted at /internal in app.ts.
 *   GET /orders/:id/status   the inventory service's SWEEPER asks "what happened to this order?"
 *                            for reservations that have been HELD too long (inventory/sweeper.ts)
 */
export const internalRouter = Router();
internalRouter.use(requireInternal);

internalRouter.get("/orders/:id/status", async (req, res) => {
  const { id } = z.object({ id: uuid }).parse(req.params);
  const order = await prisma.order.findUnique({ where: { id }, select: { status: true } });
  if (!order) return res.status(404).json({ error: "order_not_found" });
  res.json({ status: order.status });
});
