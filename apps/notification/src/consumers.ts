import { consumerDef } from "@scalecart/events";

/** The consumer groups the NOTIFICATION service runs. */
export const consumers = [consumerDef("notification", async () => (await import("./notification.handler.js")).notificationHandler)];
