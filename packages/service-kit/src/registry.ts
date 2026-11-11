import { kitEnv as env } from "./env.js";

/**
 * SERVICE REGISTRY: the one place that knows which services exist and where they live.
 *
 *   browser ──► API Gateway :3000 ──┬──► order        :3001  auth, products, cart, orders, admin
 *                                   ├──► payment      :3002  charges cards (consumes OrderCreated)
 *                                   ├──► inventory    :3003  stock + reservations
 *                                   └──► notification :3004  the customer's notification bell
 *
 * In production this is "service discovery" (Kubernetes DNS, Consul, ...). Locally the address is
 * just 127.0.0.1 + a port. The URLs are MUTABLE on purpose: tests start every service on a random
 * free port and write the real addresses in here.
 */
export type ServiceName = "order" | "payment" | "inventory" | "notification";

export const SERVICE_NAMES: ServiceName[] = ["order", "payment", "inventory", "notification"];

const local = (port: number) => `http://127.0.0.1:${port}`;

export const serviceUrls: Record<ServiceName, string> = {
  order: env.ORDER_SERVICE_URL ?? local(env.ORDER_PORT),
  payment: env.PAYMENT_SERVICE_URL ?? local(env.PAYMENT_PORT),
  inventory: env.INVENTORY_SERVICE_URL ?? local(env.INVENTORY_PORT),
  notification: env.NOTIFICATION_SERVICE_URL ?? local(env.NOTIFICATION_PORT),
};

export const servicePorts: Record<ServiceName, number> = {
  order: env.ORDER_PORT,
  payment: env.PAYMENT_PORT,
  inventory: env.INVENTORY_PORT,
  notification: env.NOTIFICATION_PORT,
};
