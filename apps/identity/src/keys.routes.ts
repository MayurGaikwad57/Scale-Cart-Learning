import { Router } from "express";
import { jwks } from "./keys.js";

/**
 * The PUBLIC signing keys (JWKS) - every other service downloads them to VERIFY tokens.
 *   GET /.well-known/jwks.json   (the standard path, as used by Google, Auth0, Keycloak, Cognito)
 */
export const keysRouter = Router();

// Public keys may be cached by verifiers: they only change on key rotation.
keysRouter.get("/.well-known/jwks.json", (_req, res) => res.set("Cache-Control", "public, max-age=300").json(jwks()));
