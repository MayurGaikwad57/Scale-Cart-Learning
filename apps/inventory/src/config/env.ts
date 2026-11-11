import { baseEnvSchema } from "@scalecart/service-kit/env";
import { z } from "zod";

// This service's settings = the kit's (JWT, ScaleKV/ScaleLog, service discovery ...) + its own.
// Read from apps/inventory/.env. Fail fast at boot instead of failing later at first use.
export const env = baseEnvSchema.extend({
  // THIS service's own database. A service-specific name, so two services can never be pointed
  // at the same database by accident (and the system tests can run every service in one process).
  INVENTORY_DATABASE_URL: z.string().min(1),
  // CONNECTION BUDGET: max open connections of THIS service's pool. Postgres allows ~100 in total,
  // so (replicas x pool size) summed over all services must stay below that.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
}).parse(process.env);
