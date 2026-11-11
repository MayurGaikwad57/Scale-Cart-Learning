import { baseEnvSchema } from "@scalecart/service-kit/env";
import { z } from "zod";

// The kit's settings (JWT, ScaleKV/ScaleLog, service discovery, internal token ...) + this
// backend's own. Fail fast at boot with a readable message instead of failing later at first use.
const schema = baseEnvSchema.extend({
  // PORT is the API GATEWAY - the only port the browser talks to.
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGIN: z.string().default("http://localhost:4300"),
  // Simulated payment-provider latency, so you can SEE the order wait in PENDING (0 in tests).
  PAYMENT_DELAY_MS: z.coerce.number().int().min(0).default(1200),
});

export const env = schema.parse(process.env);
