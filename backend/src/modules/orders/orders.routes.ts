import { Router } from "express";
import { fingerprint, idempotencyKeySchema, withIdempotency } from "../../lib/idempotency.js";
import { authenticate } from "../../middleware/auth.js";
import { limits } from "../../middleware/rateLimit.js";
import { validateBody } from "../../middleware/validate.js";
import { idParams } from "../../utils/validation.js";
import { createOrderSchema, listOrdersQuery, ordersService } from "./orders.service.js";

export const ordersRouter = Router();
ordersRouter.use(authenticate);

// Checkout. Send "Idempotency-Key: <uuid>" and retries of the same attempt can never create a
// second order: they get the original response back (with "Idempotent-Replayed: true").
ordersRouter.post("/", limits.orders, validateBody(createOrderSchema), async (req, res) => {
  const userId = req.user!.id;
  const key = idempotencyKeySchema.parse(req.header("Idempotency-Key"));
  const result = await withIdempotency({
    scope: `order:${userId}`,
    key,
    fingerprint: fingerprint(req.body),
    run: async () => {
      const { order, replayed } = await ordersService.create(userId, req.body.paymentMethod, key);
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
