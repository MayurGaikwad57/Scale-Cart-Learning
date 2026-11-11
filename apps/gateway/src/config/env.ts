import { baseEnvSchema } from "@scalecart/service-kit/env";
import { z } from "zod";

// This service's settings = the kit's (JWT, ScaleKV/ScaleLog, service discovery ...) + its own.
// Read from apps/gateway/.env. Fail fast at boot instead of failing later at first use.
export const env = baseEnvSchema.extend({
  PORT: z.coerce.number().default(3000),
  CORS_ORIGIN: z.string().default("http://localhost:4300"),
}).parse(process.env);
