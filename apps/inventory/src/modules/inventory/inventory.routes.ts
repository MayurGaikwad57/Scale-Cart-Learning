import { Router } from "express";
import { authenticate, requireRole } from "@scalecart/service-kit/auth";
import { validateBody } from "@scalecart/service-kit/validate";
import { z } from "zod";
import { uuid } from "@scalecart/service-kit/validation";
import { inventoryService, setStockSchema } from "./inventory.service.js";

export const inventoryRouter = Router();

inventoryRouter.get("/:productId", async (req, res) => {
  const { productId } = z.object({ productId: uuid }).parse(req.params);
  res.json(await inventoryService.get(productId));
});

inventoryRouter.post("/", authenticate, requireRole("ADMIN"), validateBody(setStockSchema), async (req, res) => {
  res.json(await inventoryService.setStock(req.body.productId, req.body.available));
});
