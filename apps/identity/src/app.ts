import { createServiceApp } from "@scalecart/service-kit/service-app";
import { db } from "./config/prisma.js";
import { jwks } from "./keys.js";
import { authRouter } from "./modules/users/users.routes.js";

/**
 * IDENTITY SERVICE (:3005) - who are you? Owns the users (its own database) and is the ONLY service
 * that can create tokens.
 *   public   POST /auth/register, POST /auth/login, GET /auth/me      - via the gateway
 *            GET  /.well-known/jwks.json  the PUBLIC keys every other service verifies tokens with
 *
 * WHY ITS OWN SERVICE: passwords and the signing key are the most sensitive data in the system. Kept
 * here, a bug in the cart can never leak a password hash or mint an admin token - and the login path
 * (bcrypt is CPU-heavy on purpose) can be scaled separately. Real systems often use an off-the-shelf
 * identity provider for this role (Keycloak, Auth0, Okta, Cognito) - same idea, same JWKS standard.
 */
export const createIdentityApp = () =>
  createServiceApp(
    "identity",
    (app) => {
      app.use("/auth", authRouter);
      // Public keys may be cached by verifiers: they only change on key rotation.
      app.get("/.well-known/jwks.json", (_req, res) => res.set("Cache-Control", "public, max-age=300").json(jwks()));
    },
    { db },
  );
