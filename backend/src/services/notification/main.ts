import { env } from "../../config/env.js";
import { db } from "../../config/prisma.js";
import { consumersOf, groupsOfService } from "../../events/workers.js";
import { runService } from "@scalecart/service-kit/service-app";
import { createNotificationApp } from "./app.js";

// npm run svc:notification
runService({ name: "notification", port: env.NOTIFICATION_PORT, app: createNotificationApp(), db, consumers: consumersOf(groupsOfService("notification")) });
