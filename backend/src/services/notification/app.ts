import { notificationsRouter } from "../../modules/notifications/notifications.routes.js";
import { createServiceApp } from "../shared/service-app.js";

/**
 * NOTIFICATION SERVICE (:3004). Writes notifications from order events (the "notification"
 * consumer group) and serves the navbar bell:
 *   GET /notifications, POST /notifications/read, POST /notifications/read-all
 *
 * WHY ITS OWN SERVICE: it is purely a REACTION to facts. If it is down, no checkout is affected -
 * notifications just arrive late (the events wait in the log). Later it would also send e-mail /
 * SMS / push, which have slow external providers of their own.
 */
export const createNotificationApp = () =>
  createServiceApp("notification", (app) => {
    app.use("/notifications", notificationsRouter);
  });
