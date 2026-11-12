import { Router } from "express";
import { authenticate, requireRole } from "@scalecart/service-kit/auth";
import { paymentsService } from "./payments.service.js";

/**
 * The payment service's (only) HTTP endpoint - its real input is the "orders" topic.
 *   GET /   recent payments + totals, for the admin "Services" page (mounted at /admin/payments)
 */
export const adminPaymentsRouter = Router();
adminPaymentsRouter.use(authenticate, requireRole("ADMIN"));

adminPaymentsRouter.get("/", async (_req, res) => {
  res.json(await paymentsService.overview());
});
