import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../config/prisma.js";
import { makeEvent, ORDERS_TOPIC, type OrderCancelled, type OrderConfirmed, type OrderCreated } from "@scalecart/events";
import { publishEvent } from "../../events/publish.js";
import { callService, ServiceCallError } from "@scalecart/service-kit/http-client";
import { badRequest, conflict, HttpError, notFound } from "@scalecart/service-kit/errors";
import { pageParams } from "@scalecart/service-kit/validation";
import { PAYMENT_METHODS } from "@scalecart/events";

export const createOrderSchema = z.object({ paymentMethod: z.enum(PAYMENT_METHODS) });
export const listOrdersQuery = z.object(pageParams);

const orderInclude = {
  items: { include: { product: { select: { name: true, sku: true, category: true } } }, orderBy: { id: "asc" } },
} satisfies Prisma.OrderInclude;

type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export const toOrderDto = (o: OrderRow) => ({
  id: o.id,
  status: o.status,
  statusReason: o.statusReason,
  totalCents: o.totalCents,
  createdAt: o.createdAt,
  items: o.items.map((i) => ({
    productId: i.productId,
    name: i.product.name,
    sku: i.product.sku,
    category: i.product.category,
    quantity: i.quantity,
    unitPriceCents: i.unitPriceCents,
    lineTotalCents: i.unitPriceCents * i.quantity,
  })),
  // M6: the order service's OWN copy of the payment outcome (learned from payment events), not a
  // read of the payment service's table. Same JSON shape as before, so the UI didn't change.
  payment: { status: o.paymentStatus, amountCents: o.totalCents },
});
export type OrderDto = ReturnType<typeof toOrderDto>;

// Same Idempotency-Key, different body -> the client is confused; refuse rather than guess.
function assertSameRequest(stored: string | null, incoming: string) {
  if (stored !== null && stored !== incoming) {
    throw new HttpError(422, "idempotency_key_reused", "This Idempotency-Key was already used for a different request.");
  }
}

const lines = (o: OrderDto) => o.items.map((i) => ({ productId: i.productId, name: i.name, quantity: i.quantity, unitPriceCents: i.unitPriceCents }));

const inventoryDown = () =>
  new HttpError(503, "inventory_unavailable", "We couldn't check stock right now (the inventory service is unavailable). Nothing was charged - please try again in a moment.");

/** The events the order service publishes about an order (one place builds them). */
export const orderEvents = {
  created: (o: OrderDto, userId: string, paymentMethod: string) =>
    makeEvent<OrderCreated>("OrderCreated", 2, { orderId: o.id, userId, status: "PENDING", totalCents: o.totalCents, paymentMethod, items: lines(o) }),
  confirmed: (o: OrderDto, userId: string) =>
    makeEvent<OrderConfirmed>("OrderConfirmed", 1, { orderId: o.id, userId, totalCents: o.totalCents, items: lines(o) }),
  cancelled: (o: OrderDto, userId: string) =>
    makeEvent<OrderCancelled>("OrderCancelled", 1, { orderId: o.id, userId, totalCents: o.totalCents, reason: o.statusReason ?? "cancelled", items: lines(o) }),
};

export type ReserveOutcome = "reserved" | "insufficient_stock" | "released" | "rejected" | "unknown" | "unreachable";

/** Same limit as the inventory service's reserveSchema: checked here so the customer gets a clear 400. */
export const MAX_ORDER_LINES = 100;

/** Synchronous call to the Inventory Service. Returns what we KNOW about the outcome. */
export async function reserveStock(orderId: string, items: { productId: string; quantity: number }[]) {
  try {
    const res = await callService<{ error?: string; productId?: string; available?: number }>(
      "inventory",
      "POST",
      "/internal/reservations",
      { orderId, items },
      { timeoutMs: 3000 },
    );
    if (res.status === 200 || res.status === 201) return { outcome: "reserved" as const };
    if (res.status === 409 && res.body.error === "insufficient_stock") {
      return { outcome: "insufficient_stock" as const, productId: res.body.productId!, available: res.body.available ?? 0 };
    }
    if (res.status === 409 && res.body.error === "reservation_released") return { outcome: "released" as const };
    // Any other 4xx: the inventory service ANSWERED and refused (bad request, wrong service token).
    // That is a definite "nothing was reserved", not an unknown outcome (found in code review).
    if (res.status >= 400 && res.status < 500) {
      console.error(`[order] inventory refused the reservation: ${res.status}`, res.body);
      return { outcome: "rejected" as const };
    }
    console.error(`[order] unexpected inventory answer ${res.status}`, res.body);
    return { outcome: "unknown" as const };
  } catch (e) {
    if (!(e instanceof ServiceCallError)) throw e;
    console.warn(`[order] reserve for ${orderId}: ${e.message}`);
    return { outcome: e.outcomeUnknown ? ("unknown" as const) : ("unreachable" as const) };
  }
}

/** Put an order's lines back into the customer's cart (used whenever an order does not go ahead). */
// While an order is PENDING the customer may already have put some of the same products back in the
// cart. Adding the order's quantities on top would DOUBLE them (found in code review), so each line
// becomes max(what is in the cart now, what was ordered) - never less than either.
async function restoreCart(tx: Prisma.TransactionClient, userId: string, items: { productId: string; quantity: number }[]) {
  const cart = await tx.cart.upsert({ where: { userId }, create: { userId }, update: {} });
  for (const i of items) {
    const current = await tx.cartItem.findUnique({ where: { cartId_productId: { cartId: cart.id, productId: i.productId } } });
    if (!current) await tx.cartItem.create({ data: { cartId: cart.id, productId: i.productId, quantity: i.quantity } });
    else if (current.quantity < i.quantity) await tx.cartItem.update({ where: { id: current.id }, data: { quantity: i.quantity } });
  }
}

export const ordersService = {
  /**
   * CHECKOUT (M6). In the monolith this was ONE database transaction that did everything. Now the
   * work is spread over three services, so it is a sequence of LOCAL steps:
   *
   *   1. order svc   [local tx]  lock cart, idempotency check, create order PENDING, empty the cart
   *   2. inventory   [sync HTTP] reserve the stock - the customer must hear "out of stock" NOW
   *        409 out of stock -> undo step 1 (order deleted, cart restored), answer 409
   *        not running      -> undo step 1, answer 503 (we KNOW nothing was reserved)
   *        timeout / 5xx    -> UNKNOWN: cancel the order + ask for a release (tombstone), 503
   *   3. publish OrderCreated (PENDING) -> payment happens ASYNCHRONOUSLY in the payment service
   *   4. answer 201 with status PENDING; the browser polls until CONFIRMED / CANCELLED
   *
   * There is no transaction spanning steps 1-3. Each step is atomic on its own; failures are
   * handled by explicit "undo" actions (COMPENSATIONS). That is the core idea of a SAGA (M7).
   */
  async create(userId: string, paymentMethod: (typeof PAYMENT_METHODS)[number], idem?: { key: string; fingerprint: string }) {
    let placed: { orderId: string; replayed: boolean };
    try {
      placed = await ordersService.place(userId, paymentMethod, idem);
    } catch (err) {
      // Last line of defence: the UNIQUE (user_id, idempotency_key) constraint. Only reachable if
      // two requests somehow got past the checks below at the same time.
      if (idem && (err as { code?: string }).code === "P2002") {
        const existing = await prisma.order.findFirst({
          where: { userId, idempotencyKey: idem.key },
          select: { id: true, idempotencyFingerprint: true },
        });
        if (existing) {
          assertSameRequest(existing.idempotencyFingerprint, idem.fingerprint);
          return { order: await ordersService.getForUser(userId, existing.id), replayed: true };
        }
      }
      throw err;
    }
    const order = await ordersService.getForUser(userId, placed.orderId);
    if (placed.replayed) return { order, replayed: true };

    const reserve = await reserveStock(order.id, order.items);
    if (reserve.outcome === "insufficient_stock" || reserve.outcome === "unreachable" || reserve.outcome === "rejected") {
      // We KNOW nothing was reserved: undo as if the order never existed.
      await ordersService.undoPlacement(order.id, userId);
      if (reserve.outcome !== "insufficient_stock") throw inventoryDown();
      const item = order.items.find((i) => i.productId === reserve.productId);
      const name = item?.name ?? "An item";
      throw conflict("insufficient_stock", reserve.available === 0 ? `"${name}" is out of stock` : `Only ${reserve.available} left of "${name}"`);
    }
    if (reserve.outcome !== "reserved") {
      // Outcome unknown: stock MAY be reserved. Cancel (cart restored, key freed so a retry is a
      // fresh attempt) and make sure the stock comes back: a direct release now (best effort) AND
      // the OrderCancelled event, which the inventory service handles even if it is down right now.
      const cancelled = await ordersService.cancel(order.id, "inventory_unavailable", "PENDING");
      if (cancelled) {
        await callService("inventory", "POST", `/internal/reservations/${order.id}/release`, undefined, { timeoutMs: 1000 }).catch(() => undefined);
        await publishEvent(ORDERS_TOPIC, orderEvents.cancelled(cancelled, userId));
      }
      throw inventoryDown();
    }

    // Stock is held. Hand over to the payment service. NOT awaited: the customer's answer must not
    // wait for the broker. If this publish is lost, the RECONCILER re-publishes (see reconciler.ts).
    void publishEvent(ORDERS_TOPIC, orderEvents.created(order, userId, paymentMethod));
    return { order, replayed: false }; // status PENDING
  },

  /** Step 1 of checkout: one local transaction in the order service's own tables. */
  async place(userId: string, paymentMethod: string, idem?: { key: string; fingerprint: string }) {
    return prisma.$transaction(
      async (tx) => {
        // Serialise checkouts of the same cart. A double-click's second request waits here, then
        // sees an already-emptied cart.
        await tx.$queryRaw`SELECT id FROM cart WHERE user_id = ${userId}::uuid FOR UPDATE`;

        // Idempotency, database layer: "LOCK, THEN CHECK" (we hold this user's cart lock).
        if (idem) {
          const existing = await tx.order.findFirst({
            where: { userId, idempotencyKey: idem.key },
            select: { id: true, idempotencyFingerprint: true },
          });
          if (existing) {
            assertSameRequest(existing.idempotencyFingerprint, idem.fingerprint);
            return { orderId: existing.id, replayed: true };
          }
        }

        const cart = await tx.cart.findUnique({ where: { userId }, include: { items: { include: { product: true } } } });
        if (!cart || cart.items.length === 0) throw badRequest("cart_empty", "Your cart is empty");
        if (cart.items.length > MAX_ORDER_LINES) {
          throw badRequest("too_many_items", `An order can contain at most ${MAX_ORDER_LINES} different products. Please split it into several orders.`);
        }
        const inactive = cart.items.find((i) => !i.product.active);
        if (inactive) throw conflict("product_unavailable", `"${inactive.product.name}" is no longer available`);

        // Price snapshot of every line. Stock is NOT touched here: it isn't ours any more.
        const totalCents = cart.items.reduce((sum, i) => sum + i.product.priceCents * i.quantity, 0);
        const order = await tx.order.create({
          data: {
            userId,
            totalCents,
            paymentMethod,
            idempotencyKey: idem?.key,
            idempotencyFingerprint: idem?.fingerprint,
            items: { create: cart.items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitPriceCents: i.product.priceCents })) },
          },
        });
        // The cart becomes the order. If the order doesn't go ahead, restoreCart() puts it back.
        await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
        return { orderId: order.id, replayed: false };
      },
      { maxWait: 5_000, timeout: 10_000 },
    );
  },

  /** Compensation for step 1 when we KNOW nothing was reserved: as if the order never existed. */
  async undoPlacement(orderId: string, userId: string) {
    await prisma.$transaction(async (tx) => {
      const items = await tx.orderItem.findMany({ where: { orderId } });
      await restoreCart(tx, userId, items);
      await tx.order.delete({ where: { id: orderId } }); // order_items cascade
    });
  },

  /**
   * PENDING -> CANCELLED (+ cart restored). Returns the order, or null if it was not PENDING any
   * more (already settled by someone else - e.g. the reconciler and a payment event racing).
   * The row lock makes "check status, then change it" safe against that race.
   */
  async cancel(orderId: string, reason: string, paymentStatus: "PENDING" | "FAILED") {
    const changed = await prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ status: string; user_id: string }[]>`
        SELECT status::text, user_id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      if (!row || row.status !== "PENDING") return false;
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: "CANCELLED",
          statusReason: reason,
          paymentStatus,
          // inventory_unavailable: the customer was answered 503 ("try again") and the browser
          // retries with the SAME key - that retry must start a NEW order, not replay this cancelled
          // one, so the key is freed. In every other case the customer already got 201 for this
          // order: the key keeps pointing at it (a reuse with a different body stays a 422).
          ...(reason === "inventory_unavailable" ? { idempotencyKey: null } : {}),
        },
      });
      await restoreCart(tx, row.user_id, await tx.orderItem.findMany({ where: { orderId } }));
      return true;
    });
    return changed ? ordersService.get(orderId) : null;
  },

  /** PENDING -> CONFIRMED. Returns the order, or null if it was not PENDING. */
  async confirm(orderId: string) {
    const { count } = await prisma.order.updateMany({
      where: { id: orderId, status: "PENDING" }, // conditional update = atomic "only if still PENDING"
      data: { status: "CONFIRMED", paymentStatus: "SUCCEEDED" },
    });
    return count ? ordersService.get(orderId) : null;
  },

  async get(orderId: string) {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
    return order && { ...toOrderDto(order), userId: order.userId, paymentMethod: order.paymentMethod };
  },

  async getForUser(userId: string, orderId: string) {
    // Filtering by userId means someone else's order is a 404 (not a 403 that confirms it exists).
    const order = await prisma.order.findFirst({ where: { id: orderId, userId }, include: orderInclude });
    if (!order) throw notFound("order_not_found");
    return toOrderDto(order);
  },

  async list(userId: string, q: z.infer<typeof listOrdersQuery>) {
    const [rows, total] = await prisma.$transaction([
      prisma.order.findMany({
        where: { userId },
        include: orderInclude,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }], // uses the (user_id, created_at DESC) index
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.order.count({ where: { userId } }),
    ]);
    return { items: rows.map(toOrderDto), total, page: q.page, pageSize: q.pageSize };
  },
};
