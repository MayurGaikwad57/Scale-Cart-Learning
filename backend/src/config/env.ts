import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  CORS_ORIGIN: z.string().default("http://localhost:4300"),
  // e.g. kv://127.0.0.1:6380 - our own Redis-like store. Optional: unset = run without it.
  KV_URL: z.string().optional(),
  // Behind a reverse proxy / load balancer, req.ip is the PROXY's address unless Express is told
  // to trust X-Forwarded-For - then every user would share one rate-limit bucket. Set it to the
  // number of proxy hops (e.g. "1") or a subnet. Leave unset when clients connect directly.
  TRUST_PROXY: z.string().optional(),
  // e.g. kv://127.0.0.1:9093 - the ScaleLog broker (our Kafka). Optional: unset = no events.
  LOG_URL: z.string().optional(),
  // Run the event consumers inside the API process too ("false" = only in `npm run worker`).
  RUN_WORKERS: z.enum(["true", "false"]).default("true"),

  // ---- M6: microservices. PORT (above) is the API GATEWAY - the only port the browser talks to.
  ORDER_PORT: z.coerce.number().default(3001),
  PAYMENT_PORT: z.coerce.number().default(3002),
  INVENTORY_PORT: z.coerce.number().default(3003),
  NOTIFICATION_PORT: z.coerce.number().default(3004),
  // Where each service can be reached. Locally: 127.0.0.1 + its port. In Kubernetes these would be
  // service DNS names like http://inventory:3003 - that is the only thing that changes.
  ORDER_SERVICE_URL: z.string().optional(),
  PAYMENT_SERVICE_URL: z.string().optional(),
  INVENTORY_SERVICE_URL: z.string().optional(),
  NOTIFICATION_SERVICE_URL: z.string().optional(),
  // Shared secret for service-to-service calls (/internal/* routes). The gateway never forwards
  // /internal, so a browser can't call them; the token stops anything else on the network.
  INTERNAL_TOKEN: z.string().min(16).default("scalecart-dev-internal-token"),
  // Simulated payment-provider latency, so you can SEE the order wait in PENDING (0 in tests).
  PAYMENT_DELAY_MS: z.coerce.number().int().min(0).default(1200),
});

// Fail fast at boot with a readable message instead of failing later at first use.
export const env = schema.parse(process.env);
