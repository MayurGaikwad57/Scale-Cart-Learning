import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { z } from "zod";
import { uuid } from "../../utils/validation.js";
import { inventoryService, setStockSchema } from "./inventory.service.js";

export const inventoryRouter = Router();

inventoryRouter.get("/:productId", async (req, res) => {
  const { productId } = z.object({ productId: uuid }).parse(req.params);
  res.json(await inventoryService.get(productId));
});

inventoryRouter.post("/", authenticate, requireRole("ADMIN"), validateBody(setStockSchema), async (req, res) => {
  res.json(await inventoryService.setStock(req.body.productId, req.body.available));
});
