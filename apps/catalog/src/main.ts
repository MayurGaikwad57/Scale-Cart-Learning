import { runService } from "@scalecart/service-kit/service-app";
import { startAnnouncer, stopAnnouncer } from "./announcer.js";
import { createCatalogApp } from "./app.js";
import { env } from "./config/env.js";
import { db } from "./config/prisma.js";
import { consumers } from "./consumers.js";

// npm run dev -w @scalecart/catalog
runService({
  name: "catalog",
  port: env.CATALOG_PORT,
  app: createCatalogApp(),
  db,
  consumers, // "product_stock"
  onStart: startAnnouncer, // re-publishes ProductCreated that couldn't be sent (broker down)
  onStop: stopAnnouncer,
});
