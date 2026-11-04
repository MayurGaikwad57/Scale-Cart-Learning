import { env } from "../../config/env.js";
import { groupsOfService } from "../../events/workers.js";
import { runService } from "../shared/service-app.js";
import { createInventoryApp } from "./app.js";
import { startSweeper, stopSweeper } from "./sweeper.js";

// npm run svc:inventory
runService({
  name: "inventory",
  port: env.INVENTORY_PORT,
  app: createInventoryApp(),
  groups: groupsOfService("inventory"),
  onStart: startSweeper, // repairs reservations left HELD by lost events
  onStop: stopSweeper,
});
