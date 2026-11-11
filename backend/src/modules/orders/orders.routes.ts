import { Router } from "express";
import { fingerprint, idempotencyKeySchema, withIdempotency } from "@scalecart/service-kit/idempotency";
import { authenticate } from "@scalecart/service-kit/auth";
import { limits } from "@scalecart/service-kit/rate-limit";
import { validateBody } from "@scalecart/service-kit/validate";
import { idParams } from "@scalecart/service-kit/validation";
import { createOrderSchema, listOrdersQuery, ordersService } from "./orders.service.js";

export const ordersRouter = Router();
ordersRouter.use(authenticate);

// Checkout. Send "Idempotency-Key: <uuid>" and retries of the same attempt can never create a
// second order: they get the original response back (with "Idempotent-Replayed: true").
ordersRouter.post("/", limits.orders, validateBody(createOrderSchema), async (req, res) => {
  const userId = req.user!.id;
  const key = idempotencyKeySchema.parse(req.header("Idempotency-Key"));
  const fp = fingerprint(req.body);
  const result = await withIdempotency({
    scope: `order:${userId}`,
    key,
    fingerprint: fp,
    run: async () => {
      const { order, replayed } = await ordersService.create(userId, req.body.paymentMethod, key ? { key, fingerprint: fp } : undefined);
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
