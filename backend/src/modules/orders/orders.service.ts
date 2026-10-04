import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client.js";
import { prisma } from "../../config/prisma.js";
import { badRequest, conflict, notFound } from "../../utils/errors.js";
import { pageParams } from "../../utils/validation.js";
import { PAYMENT_METHODS, paymentsService } from "../payments/payments.service.js";

export const createOrderSchema = z.object({ paymentMethod: z.enum(PAYMENT_METHODS) });
export const listOrdersQuery = z.object(pageParams);

const orderInclude = {
  items: { include: { product: { select: { name: true, sku: true, category: true } } }, orderBy: { id: "asc" } },
  payments: { orderBy: { createdAt: "desc" } },
} satisfies Prisma.OrderInclude;

type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

const toDto = (o: OrderRow) => ({
  id: o.id,
  status: o.status,
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
  payment: o.payments[0]
    ? { status: o.payments[0].status, amountCents: o.payments[0].amountCents }
    : null,
});

export const ordersService = {
  /**
   * Checkout. ONE database transaction:
   *   lock cart -> lock stock rows (fixed order) -> reserve stock -> create order
   *   -> charge payment -> confirm (stock sold) OR cancel (stock released)
   * Any thrown error rolls the whole thing back, so we can never end up with an order
   * but no stock change, or the reverse.
   */
  async create(userId: string, paymentMethod: (typeof PAYMENT_METHODS)[number]) {
    const orderId = await prisma.$transaction(
      async (tx) => {
        // 1. Serialise checkouts of the same cart. A double-click's second request waits here, then
        //    sees an already-emptied cart. (Retries across network failures need Phase 2 idempotency keys.)
        await tx.$queryRaw`SELECT id FROM cart WHERE user_id = ${userId}::uuid FOR UPDATE`;

        const cart = await tx.cart.findUnique({
          where: { userId },
          include: { items: { include: { product: true } } },
        });
        if (!cart || cart.items.length === 0) throw badRequest("cart_empty", "Your cart is empty");

        const inactive = cart.items.find((i) => !i.product.active);
        if (inactive) throw conflict("product_unavailable", `"${inactive.product.name}" is no longer available`);

        // 2. Lock the stock rows. ORDER BY product_id gives every transaction the same lock order,
        //    which prevents deadlocks between two carts that share products. Other buyers of these
        //    products block here until we commit, so the availability check below cannot be stale.
        const ids = cart.items.map((i) => i.productId);
        const locked = await tx.$queryRaw<{ product_id: string; available: number }[]>`
          SELECT product_id, available FROM inventory
          WHERE product_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
          ORDER BY product_id
          FOR UPDATE`;
        const available = new Map(locked.map((r) => [r.product_id, r.available]));

        for (const item of cart.items) {
          const have = available.get(item.productId) ?? 0;
          if (have < item.quantity) {
            throw conflict(
              "insufficient_stock",
              have === 0
                ? `"${item.product.name}" is out of stock`
                : `Only ${have} left of "${item.product.name}"`,
            );
          }
        }

        // 3. Reserve: available -> reserved.
        for (const item of cart.items) {
          await tx.inventory.update({
            where: { productId: item.productId },
            data: {
              available: { decrement: item.quantity },
              reserved: { increment: item.quantity },
              version: { increment: 1 },
            },
          });
        }

        // 4. Create the order with a price snapshot of every line.
        const totalCents = cart.items.reduce((sum, i) => sum + i.product.priceCents * i.quantity, 0);
        const order = await tx.order.create({
          data: {
            userId,
            totalCents,
            items: {
              create: cart.items.map((i) => ({
                productId: i.productId,
                quantity: i.quantity,
                unitPriceCents: i.product.priceCents,
              })),
            },
          },
        });

        // 5. Pay, then settle.
        const payment = await paymentsService.charge(tx, { orderId: order.id, amountCents: totalCents, method: paymentMethod });

        if (payment.status === "SUCCEEDED") {
          // Reservation becomes a sale; the cart is consumed.
          for (const item of cart.items) {
            await tx.inventory.update({
              where: { productId: item.productId },
              data: { reserved: { decrement: item.quantity }, version: { increment: 1 } },
            });
          }
          await tx.order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });
          await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
        } else {
          // Compensation: give the reserved stock back and cancel. The order is kept (as CANCELLED)
          // so the user can see what happened; the cart is kept so they can retry.
          for (const item of cart.items) {
            await tx.inventory.update({
              where: { productId: item.productId },
              data: {
                available: { increment: item.quantity },
                reserved: { decrement: item.quantity },
                version: { increment: 1 },
              },
            });
          }
          await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
        }
        return order.id;
      },
      { maxWait: 5_000, timeout: 10_000 },
    );

    return ordersService.getForUser(userId, orderId);
  },

  async getForUser(userId: string, orderId: string) {
    // Filtering by userId means someone else's order is a 404 (not a 403 that confirms it exists).
    const order = await prisma.order.findFirst({ where: { id: orderId, userId }, include: orderInclude });
    if (!order) throw notFound("order_not_found");
    return toDto(order);
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
    return { items: rows.map(toDto), total, page: q.page, pageSize: q.pageSize };
  },
};
