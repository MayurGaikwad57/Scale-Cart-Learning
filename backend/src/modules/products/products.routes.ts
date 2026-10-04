import { Router } from "express";
import { authenticate, optionalAuth, requireRole } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { productsController as c } from "./products.controller.js";
import { createProductSchema, updateProductSchema } from "./products.validation.js";

export const productsRouter = Router();

// Public reads (optionalAuth lets admins also see inactive products).
productsRouter.get("/", optionalAuth, c.list);
productsRouter.get("/categories", c.categories); // before "/:id" so "categories" isn't read as an id
productsRouter.get("/:id", optionalAuth, c.get);

// Admin writes.
productsRouter.post("/", authenticate, requireRole("ADMIN"), validateBody(createProductSchema), c.create);
productsRouter.put("/:id", authenticate, requireRole("ADMIN"), validateBody(updateProductSchema), c.update);
productsRouter.delete("/:id", authenticate, requireRole("ADMIN"), c.remove);
