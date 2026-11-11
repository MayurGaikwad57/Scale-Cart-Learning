import { baseEnvSchema } from "@scalecart/service-kit/env";
import { z } from "zod";

// This service's settings = the kit's (ScaleKV, service discovery ...) + its own.
// Read from apps/identity/.env. Fail fast at boot instead of failing later at first use.
export const env = baseEnvSchema.extend({
  // THIS service's own database (users).
  IDENTITY_DATABASE_URL: z.string().min(1),
  // CONNECTION BUDGET: max open connections of THIS service's pool.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
  // The RSA PRIVATE key that signs tokens (PEM, base64-encoded so it fits on one .env line) and its
  // key id. Created by: npm run keys -w @scalecart/identity. ONLY this service has it.
  JWT_PRIVATE_KEY: z.string().min(100),
  JWT_KEY_ID: z.string().min(1),
}).parse(process.env);
