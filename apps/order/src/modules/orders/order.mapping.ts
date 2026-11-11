import { makeEvent, type OrderCancelled, type OrderConfirmed, type OrderCreated } from "@scalecart/events";
import type { Prisma } from "../../generated/prisma/client.js";

/**
 * How an order LOOKS from outside the order service: the API's JSON (DTO) and the events it
 * publishes. One place builds both, so they can't drift apart.
 */
export const orderInclude = {
  items: { orderBy: { id: "asc" } },
} satisfies Prisma.OrderInclude;

export type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export const toOrderDto = (o: OrderRow) => ({
  id: o.id,
  status: o.status,
  statusReason: o.statusReason,
  totalCents: o.totalCents,
  createdAt: o.createdAt,
  items: o.items.map((i) => ({
    productId: i.productId,
    // The SNAPSHOT taken at checkout - showing an order never needs the catalog service.
    name: i.productName,
    sku: i.productSku,
    category: i.productCategory,
    quantity: i.quantity,
    unitPriceCents: i.unitPriceCents,
    lineTotalCents: i.unitPriceCents * i.quantity,
  })),
  // The order service's OWN copy of the payment outcome (learned from payment events), not a read
  // of the payment service's table.
  payment: { status: o.paymentStatus, amountCents: o.totalCents },
});
export type OrderDto = ReturnType<typeof toOrderDto>;

const lines = (o: OrderDto) => o.items.map((i) => ({ productId: i.productId, name: i.name, quantity: i.quantity, unitPriceCents: i.unitPriceCents }));

/** The events the order service publishes about an order. */
export const orderEvents = {
  created: (o: OrderDto, userId: string, paymentMethod: string) =>
    makeEvent<OrderCreated>("OrderCreated", 2, { orderId: o.id, userId, status: "PENDING", totalCents: o.totalCents, paymentMethod, items: lines(o) }),
  confirmed: (o: OrderDto, userId: string) =>
    makeEvent<OrderConfirmed>("OrderConfirmed", 1, { orderId: o.id, userId, totalCents: o.totalCents, items: lines(o) }),
  cancelled: (o: OrderDto, userId: string) =>
    makeEvent<OrderCancelled>("OrderCancelled", 1, { orderId: o.id, userId, totalCents: o.totalCents, reason: o.statusReason ?? "cancelled", items: lines(o) }),
};
