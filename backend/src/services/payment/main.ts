import { env } from "../../config/env.js";
import { groupsOfService } from "../../events/workers.js";
import { runService } from "../shared/service-app.js";
import { createPaymentApp } from "./app.js";

// npm run svc:payment
runService({ name: "payment", port: env.PAYMENT_PORT, app: createPaymentApp(), groups: groupsOfService("payment") });
