import { Router } from "express";
import { fingerprint, idempotencyKeySchema, withIdempotency } from "@scalecart/service-kit/idempotency";
import { authenticate } from "@scalecart/service-kit/auth";
import { rateLimit } from "@scalecart/service-kit/rate-limit";
import { validateBody } from "@scalecart/service-kit/validate";
import { idParams } from "@scalecart/service-kit/validation";
import { checkout } from "./checkout.saga.js";
import { ordersService } from "./orders.service.js";
import { createOrderSchema, listOrdersQuery } from "./orders.validation.js";

export const ordersRouter = Router();
ordersRouter.use(authenticate);

// Checkout. Send "Idempotency-Key: <uuid>" and retries of the same attempt can never create a
// second order: they get the original response back (with "Idempotent-Replayed: true").
// THIS service's policy: 10 checkouts per minute per user - placing orders is expensive (row locks,
// a call to the inventory service, a payment).
const checkoutLimit = rateLimit({ name: "order.checkout", limit: 10, windowMs: 60_000, appliesTo: "placing orders" });

ordersRouter.post("/", checkoutLimit, validateBody(createOrderSchema), async (req, res) => {
  const userId = req.user!.id;
  const key = idempotencyKeySchema.parse(req.header("Idempotency-Key"));
  const fp = fingerprint(req.body);
  const result = await withIdempotency({
    scope: `order:${userId}`,
    key,
    fingerprint: fp,
    run: async () => {
      const { order, replayed } = await checkout(userId, req.body.paymentMethod, key ? { key, fingerprint: fp } : undefined);
      return { status: 201, body: order, replayed };
    },
  });
  if (result.replayed) res.set("Idempotent-Replayed", "true");
  res.status(result.status).json(result.body);
});

ordersRouter.get("/", async (req, res) => {
  res.json(await ordersService.list(req.user!.id, listOrdersQuery.parse(req.query)));
});

ordersRouter.get("/:id", async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await ordersService.getForUser(req.user!.id, id));
});
