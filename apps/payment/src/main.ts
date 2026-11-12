import { env } from "./config/env.js";
import { db } from "./config/prisma.js";
import { consumers } from "./consumers.js";
import { runService } from "@scalecart/service-kit/service-app";
import { createPaymentApp } from "./app.js";

// npm run dev -w @scalecart/payment
runService({ name: "payment", port: env.PAYMENT_PORT, app: createPaymentApp(), db, consumers });
