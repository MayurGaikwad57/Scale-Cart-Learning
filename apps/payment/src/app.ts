import { db } from "./config/prisma.js";
import { authenticate, requireRole } from "@scalecart/service-kit/auth";
import { paymentsService } from "./modules/payments/payments.service.js";
import { createServiceApp } from "@scalecart/service-kit/service-app";

/**
 * PAYMENT SERVICE (:3002). Has almost no HTTP API - its real input is the "orders" topic
 * (payment.handler.ts). It owns the payments table: no other service reads or writes it.
 *   GET /admin/payments   recent payments + totals (admin page "Services")
 *
 * WHY ITS OWN SERVICE: different failure characteristics (an external provider that is slow or
 * down), its own retry / timeout / idempotency rules, and it can be scaled or paused without
 * touching checkout. If it is down, orders wait in PENDING and are charged when it comes back.
 */
export const createPaymentApp = () =>
  createServiceApp("payment", (app) => {
    app.get("/admin/payments", authenticate, requireRole("ADMIN"), async (_req, res) => {
      res.json(await paymentsService.overview());
    });
  }, { db });
