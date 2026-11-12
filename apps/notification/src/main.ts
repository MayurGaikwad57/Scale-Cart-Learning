import { env } from "./config/env.js";
import { db } from "./config/prisma.js";
import { consumers } from "./consumers.js";
import { runService } from "@scalecart/service-kit/service-app";
import { createNotificationApp } from "./app.js";

// npm run dev -w @scalecart/notification
runService({ name: "notification", port: env.NOTIFICATION_PORT, app: createNotificationApp(), db, consumers });
