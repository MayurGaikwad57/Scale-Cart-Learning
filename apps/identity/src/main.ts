import { runService } from "@scalecart/service-kit/service-app";
import { createIdentityApp } from "./app.js";
import { env } from "./config/env.js";
import { db } from "./config/prisma.js";

// npm run dev -w @scalecart/identity
runService({ name: "identity", port: env.IDENTITY_PORT, app: createIdentityApp(), db });
