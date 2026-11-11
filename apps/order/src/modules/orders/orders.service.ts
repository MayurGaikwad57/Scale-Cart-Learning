import type { z } from "zod";
import { badRequest, conflict, HttpError, notFound } from "@scalecart/service-kit/errors";
import { getProducts } from "../../clients/catalog.client.js";
import { prisma } from "../../config/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { orderInclude, toOrderDto } from "./order.mapping.js";
import { MAX_ORDER_LINES, type listOrdersQuery } from "./orders.validation.js";

/**
 * The ORDER itself: its local state changes (place, undo, cancel, confirm) and queries - all inside
 * the order service's own database. Deciding WHEN to do which (the saga) is in checkout.saga.ts.
 */
type Idem = { key: string; fingerprint: string };

// Same Idempotency-Key, different body -> the client is confused; refuse rather than guess.
function assertSameRequest(stored: string | null, incoming: string) {
  if (stored !== null && stored !== incoming) {
    throw new HttpError(422, "idempotency_key_reused", "This Idempotency-Key was already used for a different request.");
  }
}

/** Put an order's lines back into the customer's cart (used whenever an order does not go ahead). */
// While an order is PENDING the customer may already have put some of the same products back in the
// cart. Adding the order's quantities on top would DOUBLE them, so each line becomes
// max(what is in the cart now, what was ordered) - never less than either.
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
   * Saga step 1, including its last line of defence: if two requests with the same Idempotency-Key
   * slipped past the checks at the same moment, the UNIQUE (user_id, idempotency_key) constraint
   * stops the second one - and it gets the first one's order back (a replay).
   */
  async placeOrReplay(userId: string, paymentMethod: string, idem?: Idem) {
    try {
      return await ordersService.place(userId, paymentMethod, idem);
    } catch (err) {
      if (idem && (err as { code?: string }).code === "P2002") {
        const existing = await prisma.order.findFirst({ where: { userId, idempotencyKey: idem.key }, select: { id: true, idempotencyFingerprint: true } });
        if (existing) {
          assertSameRequest(existing.idempotencyFingerprint, idem.fingerprint);
          return { orderId: existing.id, replayed: true };
        }
      }
      throw err;
    }
  },

  /** Step 1 of checkout: one local transaction in the order service's own tables. */
  async place(userId: string, paymentMethod: string, idem?: Idem) {
    // Names and prices come from the CATALOG service. We ask BEFORE opening the transaction: never
    // hold database locks while waiting for the network (a slow catalog would block every checkout
    // of this cart and pile up locks). Inside, we only use what we fetched here.
    const cartNow = await prisma.cartItem.findMany({ where: { cart: { userId } }, select: { productId: true } });
    if (cartNow.length > MAX_ORDER_LINES) {
      throw badRequest("too_many_items", `An order can contain at most ${MAX_ORDER_LINES} different products. Please split it into several orders.`);
    }
    const fetchedIds = new Set(cartNow.map((i) => i.productId));
    // A RETRY of an order that already exists (same Idempotency-Key) must replay it even when the
    // catalog is down - it needs no product data (the transaction below replays before using any).
    const isReplay = !!idem && !!(await prisma.order.findFirst({ where: { userId, idempotencyKey: idem.key }, select: { id: true } }));
    const products = isReplay ? new Map() : await getProducts([...fetchedIds]);

    return prisma.$transaction(
      async (tx) => {
        // Serialise checkouts of the same cart. A double-click's second request waits here, then
        // sees an already-emptied cart.
        await tx.$queryRaw`SELECT id FROM cart WHERE user_id = ${userId}::uuid FOR UPDATE`;

        // Idempotency, database layer: "LOCK, THEN CHECK" (we hold this user's cart lock).
        if (idem) {
          const existing = await tx.order.findFirst({ where: { userId, idempotencyKey: idem.key }, select: { id: true, idempotencyFingerprint: true } });
          if (existing) {
            assertSameRequest(existing.idempotencyFingerprint, idem.fingerprint);
            return { orderId: existing.id, replayed: true };
          }
        }

        const cart = await tx.cart.findUnique({ where: { userId }, include: { items: true } });
        if (!cart || cart.items.length === 0) throw badRequest("cart_empty", "Your cart is empty");
        if (cart.items.length > MAX_ORDER_LINES) {
          throw badRequest("too_many_items", `An order can contain at most ${MAX_ORDER_LINES} different products. Please split it into several orders.`);
        }
        // The cart changed between our catalog call and the lock (another tab added a product).
        if (cart.items.some((i) => !fetchedIds.has(i.productId))) throw conflict("cart_changed", "Your cart just changed - please review it and try again.");
        const lines = cart.items.map((i) => ({ ...i, product: products.get(i.productId) }));
        const gone = lines.find((l) => !l.product || !l.product.active);
        if (gone) throw conflict("product_unavailable", `"${gone.product?.name ?? "A product in your cart"}" is no longer available`);

        // SNAPSHOT of every line (price, name, sku, category). Stock is NOT touched here: it isn't ours.
        const totalCents = lines.reduce((sum, l) => sum + l.product!.priceCents * l.quantity, 0);
        const order = await tx.order.create({
          data: {
            userId,
            totalCents,
            paymentMethod,
            idempotencyKey: idem?.key,
            idempotencyFingerprint: idem?.fingerprint,
            items: {
              create: lines.map((l) => ({
                productId: l.productId,
                quantity: l.quantity,
                unitPriceCents: l.product!.priceCents,
                productName: l.product!.name,
                productSku: l.product!.sku,
                productCategory: l.product!.category,
              })),
            },
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
