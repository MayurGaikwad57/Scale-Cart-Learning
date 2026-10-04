import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { idParams } from "../../utils/validation.js";
import { addItemSchema, cartService, updateItemSchema } from "./cart.service.js";

export const cartRouter = Router();
cartRouter.use(authenticate); // every cart route needs a logged-in user

cartRouter.get("/", async (req, res) => {
  res.json(await cartService.get(req.user!.id));
});

cartRouter.post("/items", validateBody(addItemSchema), async (req, res) => {
  res.status(201).json(await cartService.addItem(req.user!.id, req.body.productId, req.body.quantity));
});

cartRouter.put("/items/:id", validateBody(updateItemSchema), async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await cartService.updateItem(req.user!.id, id, req.body.quantity));
});

cartRouter.delete("/items/:id", async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await cartService.removeItem(req.user!.id, id));
});
