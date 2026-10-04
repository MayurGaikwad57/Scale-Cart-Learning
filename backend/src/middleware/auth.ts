import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { forbidden, unauthorized } from "../utils/errors.js";

export type Role = "CUSTOMER" | "ADMIN";
export interface AuthUser {
  id: string;
  role: Role;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

// Reads "Authorization: Bearer <token>", verifies the signature, and attaches req.user.
export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw unauthorized("missing_token");
  try {
    const payload = jwt.verify(header.slice(7), env.JWT_SECRET) as jwt.JwtPayload;
    req.user = { id: payload.sub as string, role: payload.role as Role };
    next();
  } catch {
    throw unauthorized("invalid_token");
  }
};

// For public routes that behave differently for logged-in users (e.g. admins see inactive
// products). A missing or bad token is not an error here: the caller is just anonymous.
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const payload = jwt.verify(header.slice(7), env.JWT_SECRET) as jwt.JwtPayload;
      req.user = { id: payload.sub as string, role: payload.role as Role };
    } catch {
      /* treat as anonymous */
    }
  }
  next();
};

// Use after authenticate: requireRole("ADMIN")
export const requireRole =
  (role: Role): RequestHandler =>
  (req, _res, next) => {
    if (req.user?.role !== role) throw forbidden("insufficient_role");
    next();
  };
