import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import request from "supertest";
import { broker } from "@scalecart/service-kit/broker";
import { kv } from "@scalecart/service-kit/kv";
import { CONSUMER_GROUPS, type ConsumerGroup } from "@scalecart/events";
import { startConsumers, stopConsumers } from "@scalecart/service-kit/consumers";
import { consumers as inventoryConsumers } from "@scalecart/inventory/consumers";
import { consumers as notificationConsumers } from "@scalecart/notification/consumers";
import { consumers as orderConsumers } from "@scalecart/order/consumers";
import { consumers as paymentConsumers } from "@scalecart/payment/consumers";

/** Every service's consumer groups (in production each runs inside its own service process). */
const ALL_CONSUMERS = [...orderConsumers, ...paymentConsumers, ...inventoryConsumers, ...notificationConsumers];

/** Start the given groups inside this test process. */
export const startWorkers = (groups: readonly ConsumerGroup[] = CONSUMER_GROUPS, opts: { log?: boolean } = {}) =>
  startConsumers(ALL_CONSUMERS.filter((c) => groups.includes(c.group as ConsumerGroup)), opts);
export const stopWorkers = stopConsumers;
import { startKvServer, type RunningKvServer } from "@scalecart/scalekv/server";
import { startLogServer, type RunningLogServer } from "@scalecart/scalelog/server";
import { paymentSettings } from "@scalecart/payment/modules/payments/payments.service";
import { serviceUrls, type ServiceName } from "@scalecart/service-kit/registry";
import { createGatewayApp } from "@scalecart/gateway/app";
import { createIdentityApp } from "@scalecart/identity/app";
import { createInventoryApp } from "@scalecart/inventory/app";
import { createNotificationApp } from "@scalecart/notification/app";
import { createOrderApp } from "@scalecart/order/app";
import { createPaymentApp } from "@scalecart/payment/app";

/**
 * The whole microservice system inside ONE test process: every service is a real HTTP server on a
 * random free port (port 0), the gateway in front of them, and (optionally) a real ScaleKV and a
 * real ScaleLog broker. Requests go browser-style through the gateway, services call each other
 * over real HTTP, events go through the real broker. Only the process boundary is missing.
 */
export interface Cluster {
  gateway: Express;
  servers: Record<ServiceName, Server>;
  kvServer?: RunningKvServer;
  logServer?: RunningLogServer;
  /** Stop one service (to test "service down"); `restart` brings it back on the same port. */
  stop(service: ServiceName): Promise<void>;
  restart(service: ServiceName): Promise<void>;
  close(): Promise<void>;
}

const factories: Record<ServiceName, () => Express> = {
  identity: createIdentityApp,
  order: createOrderApp,
  payment: createPaymentApp,
  inventory: createInventoryApp,
  notification: createNotificationApp,
};

const listen = (app: Express, port = 0) =>
  new Promise<Server>((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });
const close = (s: Server) =>
  new Promise<void>((resolve) => {
    s.closeAllConnections();
    s.close(() => resolve());
  });

export async function startCluster(opts: { kv?: boolean; log?: boolean; groups?: readonly ConsumerGroup[] } = {}): Promise<Cluster> {
  paymentSettings.providerDelayMs = 0;
  let kvServer: RunningKvServer | undefined;
  let logServer: RunningLogServer | undefined;
  if (opts.kv) {
    kvServer = await startKvServer({ port: 0 });
    kv.connect(`kv://127.0.0.1:${kvServer.port}`);
    await kv.waitUntilReady();
  }
  if (opts.log) {
    logServer = await startLogServer({ port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "scalelog-m6-")) });
    broker.conn.connect(`kv://127.0.0.1:${logServer.port}`);
    await broker.conn.waitUntilReady();
    // Default: every group EXCEPT analytics. The analytics projection is one shared row per day in
    // the (shared) dev database; only m5-events.test.ts asserts exact numbers on it, so only that
    // file may run it - otherwise test files running in parallel would race on the same row.
    startWorkers(opts.groups ?? CONSUMER_GROUPS.filter((g) => g !== "analytics"), { log: false });
  }

  const servers = {} as Record<ServiceName, Server>;
  for (const name of Object.keys(factories) as ServiceName[]) {
    servers[name] = await listen(factories[name]());
    serviceUrls[name] = `http://127.0.0.1:${(servers[name].address() as AddressInfo).port}`;
  }

  return {
    gateway: createGatewayApp(),
    servers,
    kvServer,
    logServer,
    async stop(service) {
      await close(servers[service]);
    },
    async restart(service) {
      servers[service] = await listen(factories[service](), Number(new URL(serviceUrls[service]).port));
    },
    async close() {
      await stopWorkers();
      await Promise.all(Object.values(servers).filter((s) => s.listening).map(close));
      if (opts.kv) await kv.disconnect();
      if (opts.log) await broker.conn.disconnect();
      await Promise.all([kvServer?.close(), logServer?.close()]);
    },
  };
}

/** Wait until an order leaves PENDING (payment is asynchronous now). Returns the final order. */
export async function settle(app: Express, auth: Record<string, string>, orderId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app).get(`/orders/${orderId}`).set(auth);
    if (res.status !== 200) throw new Error(`GET /orders/${orderId} -> ${res.status}`);
    if (res.body.status !== "PENDING") return res.body as { id: string; status: string; statusReason: string | null; payment: { status: string } };
    if (Date.now() > deadline) throw new Error(`order ${orderId} still PENDING after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Poll until `check` returns a truthy value (for effects of asynchronous consumers). */
type Truthy<T> = Exclude<T, false | null | undefined | 0 | "">;
export async function eventually<T>(check: () => Promise<T>, timeoutMs = 10_000): Promise<Truthy<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v as Truthy<T>;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}
