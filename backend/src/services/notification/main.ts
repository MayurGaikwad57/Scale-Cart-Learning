import { env } from "../../config/env.js";
import { groupsOfService } from "../../events/workers.js";
import { runService } from "../shared/service-app.js";
import { createNotificationApp } from "./app.js";

// npm run svc:notification
runService({ name: "notification", port: env.NOTIFICATION_PORT, app: createNotificationApp(), groups: groupsOfService("notification") });
