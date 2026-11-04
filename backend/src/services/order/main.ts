import { env } from "../../config/env.js";
import { groupsOfService } from "../../events/workers.js";
import { runService } from "../shared/service-app.js";
import { createOrderApp } from "./app.js";
import { startReconciler, stopReconciler } from "./reconciler.js";

// npm run svc:order
runService({
  name: "order",
  port: env.ORDER_PORT,
  app: createOrderApp(),
  groups: groupsOfService("order"), // "order" (payment results) + "analytics"
  onStart: startReconciler,
  onStop: stopReconciler,
});
