import { env } from "../../config/env.js";
import { db } from "../../config/prisma.js";
import { consumersOf, groupsOfService } from "../../events/workers.js";
import { runService } from "@scalecart/service-kit/service-app";
import { createPaymentApp } from "./app.js";

// npm run svc:payment
runService({ name: "payment", port: env.PAYMENT_PORT, app: createPaymentApp(), db, consumers: consumersOf(groupsOfService("payment")) });
