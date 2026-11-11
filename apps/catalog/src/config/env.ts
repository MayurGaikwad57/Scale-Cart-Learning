import { baseEnvSchema } from "@scalecart/service-kit/env";
import { z } from "zod";

// This service's settings = the kit's (ScaleKV/ScaleLog, service discovery ...) + its own.
// Read from apps/catalog/.env. Fail fast at boot instead of failing later at first use.
export const env = baseEnvSchema.extend({
  // THIS service's own database (products).
  CATALOG_DATABASE_URL: z.string().min(1),
  // CONNECTION BUDGET: max open connections of THIS service's pool.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
}).parse(process.env);
