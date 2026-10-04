import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { idParams } from "../../utils/validation.js";
import { createOrderSchema, listOrdersQuery, ordersService } from "./orders.service.js";

export const ordersRouter = Router();
ordersRouter.use(authenticate);

ordersRouter.post("/", validateBody(createOrderSchema), async (req, res) => {
  res.status(201).json(await ordersService.create(req.user!.id, req.body.paymentMethod));
});

ordersRouter.get("/", async (req, res) => {
  res.json(await ordersService.list(req.user!.id, listOrdersQuery.parse(req.query)));
});

ordersRouter.get("/:id", async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await ordersService.getForUser(req.user!.id, id));
});
