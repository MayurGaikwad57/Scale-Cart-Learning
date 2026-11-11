import "dotenv/config";
import { z } from "zod";

/**
 * The settings EVERY service needs (the chassis, service discovery, auth, ScaleKV/ScaleLog).
 * Each app extends this with its own settings:   baseEnvSchema.extend({ DATABASE_URL: ... })
 * Parsed at startup: a missing or invalid value stops the process immediately (fail fast).
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  JWT_SECRET: z.string().min(16),
  // e.g. kv://127.0.0.1:6380 - our own Redis-like store. Optional: unset = run without it.
  KV_URL: z.string().optional(),
  // e.g. kv://127.0.0.1:9093 - the ScaleLog broker (our Kafka). Optional: unset = no events.
  LOG_URL: z.string().optional(),
  // Run the event consumers inside the service process ("false" = only in `npm run worker`).
  RUN_WORKERS: z.enum(["true", "false"]).default("true"),
  // Behind a reverse proxy / load balancer, req.ip is the PROXY's address unless Express is told
  // to trust X-Forwarded-For - then every user would share one rate-limit bucket. Set it to the
  // number of proxy hops (e.g. "1") or a subnet. Unset = trust only loopback (our local gateway).
  TRUST_PROXY: z.string().optional(),
  // Shared secret for service-to-service calls (/internal/* routes). The gateway never forwards
  // /internal, so a browser can't call them; the token stops anything else on the network.
  INTERNAL_TOKEN: z.string().min(16).default("scalecart-dev-internal-token"),

  // SERVICE DISCOVERY: where each service listens / can be reached. Locally: 127.0.0.1 + its port.
  // In Kubernetes these would be service DNS names like http://inventory:3003 - only config changes.
  ORDER_PORT: z.coerce.number().default(3001),
  PAYMENT_PORT: z.coerce.number().default(3002),
  INVENTORY_PORT: z.coerce.number().default(3003),
  NOTIFICATION_PORT: z.coerce.number().default(3004),
  ORDER_SERVICE_URL: z.string().optional(),
  PAYMENT_SERVICE_URL: z.string().optional(),
  INVENTORY_SERVICE_URL: z.string().optional(),
  NOTIFICATION_SERVICE_URL: z.string().optional(),
});

export const kitEnv = baseEnvSchema.parse(process.env);
