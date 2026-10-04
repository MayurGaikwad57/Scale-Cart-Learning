import { Router } from "express";
import { cartRouter } from "../modules/cart/cart.routes.js";
import { inventoryRouter } from "../modules/inventory/inventory.routes.js";
import { ordersRouter } from "../modules/orders/orders.routes.js";
import { productsRouter } from "../modules/products/products.routes.js";
import { authRouter } from "../modules/users/users.routes.js";

// Central place where each module's router is mounted under its URL prefix.
export const apiRouter = Router();
apiRouter.use("/auth", authRouter);
apiRouter.use("/products", productsRouter);
apiRouter.use("/inventory", inventoryRouter);
apiRouter.use("/cart", cartRouter);
apiRouter.use("/orders", ordersRouter);
