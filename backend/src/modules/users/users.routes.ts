import { Router } from "express";
import { validateBody } from "../../middleware/validate.js";
import { usersController } from "./users.controller.js";
import { loginSchema, registerSchema } from "./users.validation.js";

export const authRouter = Router();
authRouter.post("/register", validateBody(registerSchema), usersController.register);
authRouter.post("/login", validateBody(loginSchema), usersController.login);
