import { Router } from "express";
import { authRouter } from "../modules/users/users.routes.js";

// Central place where each module's router is mounted under its URL prefix.
export const apiRouter = Router();
apiRouter.use("/auth", authRouter);
