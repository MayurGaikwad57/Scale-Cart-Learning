import { env } from "../../config/env.js";
import { db } from "../../config/prisma.js";
import { consumersOf, groupsOfService } from "../../events/workers.js";
import { runService } from "@scalecart/service-kit/service-app";
import { createOrderApp } from "./app.js";
import { startReconciler, stopReconciler } from "./reconciler.js";

// npm run svc:order
runService({
  name: "order",
  port: env.ORDER_PORT,
  app: createOrderApp(),
  db, consumers: consumersOf(groupsOfService("order")), // "order" (payment results) + "analytics"
  onStart: startReconciler,
  onStop: stopReconciler,
});
