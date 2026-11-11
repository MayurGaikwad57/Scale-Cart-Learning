import { env } from "./config/env.js";
import { db } from "./config/prisma.js";
import { consumers } from "./consumers.js";
import { runService } from "@scalecart/service-kit/service-app";
import { createInventoryApp } from "./app.js";
import { startSweeper, stopSweeper } from "./sweeper.js";

// npm run svc:inventory
runService({
  name: "inventory",
  port: env.INVENTORY_PORT,
  app: createInventoryApp(),
  db, consumers,
  onStart: startSweeper, // repairs reservations left HELD by lost events
  onStop: stopSweeper,
});
