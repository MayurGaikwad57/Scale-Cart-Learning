import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { limits } from "../../middleware/rateLimit.js";
import { validateBody } from "../../middleware/validate.js";
import { usersController } from "./users.controller.js";
import { loginSchema, registerSchema } from "./users.validation.js";

export const authRouter = Router();
// limits.auth: at most 10 attempts per minute per IP - slows down password guessing.
authRouter.post("/register", limits.auth, validateBody(registerSchema), usersController.register);
authRouter.post("/login", limits.auth, validateBody(loginSchema), usersController.login);
// Lets the frontend restore the session after a page reload (token in storage -> who am I?).
authRouter.get("/me", authenticate, usersController.me);
