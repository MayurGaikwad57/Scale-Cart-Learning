import { Router } from "express";
import { authenticate } from "@scalecart/service-kit/auth";
import { byIp, rateLimit } from "@scalecart/service-kit/rate-limit";
import { validateBody } from "@scalecart/service-kit/validate";
import { usersController } from "./users.controller.js";
import { loginSchema, registerSchema } from "./users.validation.js";

export const authRouter = Router();
// THIS service's policy: at most 10 login/register attempts per minute per IP - slows down password
// guessing. (Try 11 wrong logins in the UI.)
const authLimit = rateLimit({ name: "identity.auth", limit: 10, windowMs: 60_000, keyBy: byIp, appliesTo: "login & register" });
authRouter.post("/register", authLimit, validateBody(registerSchema), usersController.register);
authRouter.post("/login", authLimit, validateBody(loginSchema), usersController.login);
// Lets the frontend restore the session after a page reload (token in storage -> who am I?).
authRouter.get("/me", authenticate, usersController.me);
