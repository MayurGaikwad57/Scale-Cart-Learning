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
});

// Fail fast at boot with a readable message instead of failing later at first use.
export const env = schema.parse(process.env);
