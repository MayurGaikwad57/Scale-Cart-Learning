import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client.js";
import { prisma } from "../../config/prisma.js";
import { LOW_STOCK_THRESHOLD } from "../../events/handlers.js";
import { invalidateProducts } from "../../modules/products/products.cache.js";
import { uuid } from "@scalecart/service-kit/validation";

/**
 * STOCK RESERVATIONS - the heart of the Inventory Service.
 *
 * A reservation is a small STATE MACHINE, one per order:
 *
 *                reserve()                commit()  (OrderConfirmed)
 *   (none) ───────────────► HELD ─────────────────────────► COMMITTED   reserved -= qty  (sold)
 *     │                       │
 *     │ release()             │ release()  (OrderCancelled)
 *     ▼                       ▼
 *   RELEASED (tombstone)    RELEASED                                    available += qty, reserved -= qty
 *
 * Every operation is IDEMPOTENT (calling it twice = calling it once), because over a network and
 * through an at-least-once log, every message can arrive twice:
 *   - reserve() on HELD/COMMITTED   -> "already reserved", nothing changes
 *   - commit()  on COMMITTED        -> nothing changes
 *   - release() on RELEASED         -> nothing changes
 *
 * THE TOMBSTONE. The order service calls reserve() with a timeout. Suppose it times out: the order
 * service doesn't know whether stock was reserved, so it cancels the order and asks for release().
 * But the slow reserve() might still arrive AFTER the release! Without protection it would reserve
 * stock for an order that is already cancelled - stock leaked forever. So release() of an order we
 * have never seen writes a RELEASED row ("this order is dead"), and a later reserve() is refused.
 *
 * CLAIM FIRST. Both reserve() and release() start with
 *     INSERT INTO reservations ... ON CONFLICT DO NOTHING RETURNING order_id
 * If another call for the same order is in progress, Postgres makes us WAIT until it commits and
 * then reports the conflict. So "check if it exists, then create it" can never race.
 */

export const reserveSchema = z.object({
  orderId: uuid,
  items: z.array(z.object({ productId: uuid, quantity: z.number().int().positive() })).min(1).max(100),
});
export type ReserveInput = z.infer<typeof reserveSchema>;

/**
 * 409 insufficient_stock. The inventory service knows ids and numbers, not product names - the
 * order service (which owns the catalog) turns this into the message the customer reads.
 */
export class InsufficientStockError extends Error {
  constructor(
    readonly productId: string,
    readonly available: number,
  ) {
    super("insufficient_stock");
  }
}
/** 409 reservation_released: the order was already cancelled (see THE TOMBSTONE). */
export class ReservationReleasedError extends Error {}

/**
 * Low-stock alerts (moved here from the M5 "inventory" consumer): read the CURRENT stock.
 * on "sale" (commit): raise / update / clear alerts. on "release": only update or clear EXISTING
 * ones - an alert means "ran low after a SALE"; a cancelled order sold nothing.
 */
async function refreshStockAlerts(tx: Prisma.TransactionClient, productIds: string[], orderId: string, on: "sale" | "release") {
  const rows = await tx.inventory.findMany({ where: { productId: { in: productIds } } });
  for (const r of rows) {
    if (r.available <= LOW_STOCK_THRESHOLD) {
      if (on === "release") {
        await tx.stockAlert.updateMany({ where: { productId: r.productId }, data: { available: r.available } });
        continue;
      }
      await tx.stockAlert.upsert({
        where: { productId: r.productId },
        create: { productId: r.productId, available: r.available, lastOrderId: orderId },
        update: { available: r.available, lastOrderId: orderId },
      });
    } else {
      await tx.stockAlert.deleteMany({ where: { productId: r.productId } }); // restocked meanwhile
    }
  }
}

// Timestamps: Prisma stores DateTime in these "timestamp without time zone" columns as UTC. A plain
// now() would store the DATABASE's local time (Asia/Calcutta here: +5:30) - the sweeper then thought
// every reservation was 5.5 hours younger than it was. So raw SQL writes UTC explicitly.
const claim = (tx: Prisma.TransactionClient, orderId: string, status: "HELD" | "RELEASED") =>
  tx.$queryRaw<{ order_id: string }[]>`
    INSERT INTO reservations (order_id, status, created_at, updated_at)
    VALUES (${orderId}::uuid, ${status}::"ReservationStatus", now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
    ON CONFLICT DO NOTHING
    RETURNING order_id`;

async function lockReservation(tx: Prisma.TransactionClient, orderId: string) {
  await tx.$queryRaw`SELECT order_id FROM reservations WHERE order_id = ${orderId}::uuid FOR UPDATE`;
  return tx.reservation.findUnique({ where: { orderId }, include: { items: true } });
}

export const reservations = {
  /**
   * Reserve every line, or nothing. The locking is the M2 checkout's, moved here unchanged:
   * lock the stock rows in a FIXED ORDER (product_id) so two orders sharing products can never
   * deadlock, check every line, then move available -> reserved.
   */
  async reserve(input: ReserveInput): Promise<{ status: "reserved" | "already_reserved" }> {
    const result = await prisma.$transaction(
      async (tx) => {
        // 1. Claim the order id (see CLAIM FIRST).
        if (!(await claim(tx, input.orderId, "HELD")).length) {
          const row = await tx.reservation.findUnique({ where: { orderId: input.orderId }, select: { status: true } });
          if (row?.status === "RELEASED") throw new ReservationReleasedError();
          return "already_reserved" as const; // a retry: the first call already did the work
        }

        // Merge duplicate lines of the same product (defensive: the cart already prevents them).
        const qty = new Map<string, number>();
        for (const i of input.items) qty.set(i.productId, (qty.get(i.productId) ?? 0) + i.quantity);
        const ids = [...qty.keys()].sort();

        // 2. Lock the stock rows in a fixed order. Other orders for these products wait here.
        const locked = await tx.$queryRaw<{ product_id: string; available: number }[]>`
          SELECT product_id, available FROM inventory
          WHERE product_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
          ORDER BY product_id
          FOR UPDATE`;
        const available = new Map(locked.map((r) => [r.product_id, r.available]));

        // 3. Check every line BEFORE changing anything: one short line = nothing reserved.
        //    Throwing rolls back the claim from step 1 too, so a later attempt starts clean.
        for (const id of ids) {
          const have = available.get(id) ?? 0;
          if (have < qty.get(id)!) throw new InsufficientStockError(id, have);
        }

        // 4. Reserve: available -> reserved.
        for (const id of ids) {
          await tx.inventory.update({
            where: { productId: id },
            data: { available: { decrement: qty.get(id)! }, reserved: { increment: qty.get(id)! }, version: { increment: 1 } },
          });
        }
        await tx.reservationItem.createMany({
          data: ids.map((productId) => ({ orderId: input.orderId, productId, quantity: qty.get(productId)! })),
        });
        return "reserved" as const;
      },
      { maxWait: 5_000, timeout: 10_000 },
    );
    // "available" changed -> product pages showing stock are stale (after commit, never inside).
    if (result === "reserved") await invalidateProducts(input.items.map((i) => i.productId), { catalog: false });
    return { status: result };
  },

  /** OrderConfirmed: the reserved units are sold. */
  async commit(orderId: string): Promise<"committed" | "already_committed" | "not_held"> {
    return prisma.$transaction(async (tx) => {
      const r = await lockReservation(tx, orderId);
      if (!r) return "not_held";
      if (r.status === "COMMITTED") return "already_committed";
      if (r.status === "RELEASED") {
        // Confirmed after release: only possible if the order service confirmed an order whose
        // stock was already given back. Loud, not silent: a SAGA (M7) handles this with a refund.
        console.error(`[inventory] order ${orderId} confirmed but its reservation was already RELEASED`);
        return "not_held";
      }
      for (const i of r.items) {
        await tx.inventory.update({
          where: { productId: i.productId },
          data: { reserved: { decrement: i.quantity }, version: { increment: 1 } },
        });
      }
      await tx.reservation.update({ where: { orderId }, data: { status: "COMMITTED" } });
      await refreshStockAlerts(tx, r.items.map((i) => i.productId), orderId, "sale");
      return "committed";
    });
  },

  /** OrderCancelled (or a reserve that timed out): give the stock back. Tombstone if unknown. */
  async release(orderId: string): Promise<"released" | "already_released" | "tombstoned" | "already_committed"> {
    let productIds: string[] = [];
    const result = await prisma.$transaction(async (tx) => {
      // Never seen this order -> the tombstone. If a reserve() for it is running right now, we
      // wait for it, get the conflict instead, and release ITS stock below.
      if ((await claim(tx, orderId, "RELEASED")).length) return "tombstoned" as const;
      const r = (await lockReservation(tx, orderId))!;
      if (r.status === "RELEASED") return "already_released" as const;
      if (r.status === "COMMITTED") {
        console.error(`[inventory] order ${orderId} cancelled but its stock was already sold - needs a refund/restock saga (M7)`);
        return "already_committed" as const;
      }
      for (const i of r.items) {
        await tx.inventory.update({
          where: { productId: i.productId },
          data: { available: { increment: i.quantity }, reserved: { decrement: i.quantity }, version: { increment: 1 } },
        });
      }
      await tx.reservation.update({ where: { orderId }, data: { status: "RELEASED" } });
      productIds = r.items.map((i) => i.productId);
      // Stock went UP: an alert raised while these units were held may no longer be true
      // (found in code review - alerts were only recomputed on commit).
      await refreshStockAlerts(tx, productIds, orderId, "release");
      return "released" as const;
    });
    if (productIds.length) await invalidateProducts(productIds, { catalog: false });
    return result;
  },

  get(orderId: string) {
    return prisma.reservation.findUnique({ where: { orderId }, include: { items: true } });
  },
};
