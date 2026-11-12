import type { RequestHandler } from "express";
import { authenticate, requireRole } from "@scalecart/service-kit/auth";
import type { ServiceName } from "@scalecart/service-kit/registry";

/**
 * THE ROUTING TABLE: which URL prefix goes to which service, and who may call it (checked at the
 * edge - the services check the token again: zero trust). First match wins, so more specific
 * prefixes come first (/admin/payments before /admin).
 */
export type Access = "public" | "user" | "admin";

export const ROUTES: { prefix: string; service: ServiceName; access: Access; timeoutMs?: number }[] = [
  { prefix: "/notifications", service: "notification", access: "user" },
  { prefix: "/inventory", service: "inventory", access: "public" }, // POST is admin-only, checked by the service
  { prefix: "/admin/payments", service: "payment", access: "admin" },
  { prefix: "/admin/system", service: "catalog", access: "admin" }, // the product cache lives in the catalog
  { prefix: "/admin", service: "order", access: "admin" },
  { prefix: "/orders", service: "order", access: "user", timeoutMs: 20_000 }, // checkout calls inventory too
  { prefix: "/cart", service: "order", access: "user" },
  { prefix: "/products", service: "catalog", access: "public" },
  { prefix: "/auth", service: "identity", access: "public" }, // /auth/me checks the token itself
];

/** Authentication AT THE EDGE: reject a missing/invalid token before it costs a service anything. */
export const edgeAuth: Record<Access, RequestHandler[]> = {
  public: [],
  user: [authenticate],
  admin: [authenticate, requireRole("ADMIN")],
};
