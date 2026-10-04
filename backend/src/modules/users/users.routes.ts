import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { usersController } from "./users.controller.js";
import { loginSchema, registerSchema } from "./users.validation.js";

export const authRouter = Router();
authRouter.post("/register", validateBody(registerSchema), usersController.register);
authRouter.post("/login", validateBody(loginSchema), usersController.login);
// Lets the frontend restore the session after a page reload (token in storage -> who am I?).
authRouter.get("/me", authenticate, usersController.me);
