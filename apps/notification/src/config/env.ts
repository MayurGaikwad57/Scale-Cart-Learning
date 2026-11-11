import { baseEnvSchema } from "@scalecart/service-kit/env";
import { z } from "zod";

// This service's settings = the kit's (JWT, ScaleKV/ScaleLog, service discovery ...) + its own.
// Read from apps/notification/.env. Fail fast at boot instead of failing later at first use.
export const env = baseEnvSchema.extend({
  DATABASE_URL: z.string().min(1),
  // CONNECTION BUDGET: max open connections of THIS service's pool. Postgres allows ~100 in total,
  // so (replicas x pool size) summed over all services must stay below that.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
}).parse(process.env);
