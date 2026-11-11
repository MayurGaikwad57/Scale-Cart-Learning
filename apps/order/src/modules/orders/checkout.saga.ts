import { ORDERS_TOPIC, type PaymentMethod } from "@scalecart/events";
import { conflict, HttpError } from "@scalecart/service-kit/errors";
import { releaseReservation, reserveStock } from "../../clients/inventory.client.js";
import { publishEvent } from "../../events/publish.js";
import { orderEvents } from "./order.mapping.js";
import { ordersService } from "./orders.service.js";

/**
 * THE CHECKOUT SAGA (orchestration). In the monolith this was ONE database transaction. Across
 * services it is a sequence of LOCAL steps, and every failure is answered by an explicit UNDO
 * (a compensation) instead of a rollback:
 *
 *   1. order svc   [local tx]  lock cart, idempotency check, create order PENDING, empty the cart
 *   2. inventory   [sync HTTP] reserve the stock - the customer must hear "out of stock" NOW
 *        out of stock / refused / not running -> we KNOW nothing was reserved: undo step 1
 *        timeout / 5xx                        -> UNKNOWN: cancel the order + release the stock
 *   3. publish OrderCreated (PENDING) -> payment happens ASYNCHRONOUSLY in the payment service
 *   4. answer 201 with status PENDING; the browser polls until CONFIRMED / CANCELLED
 *
 * This file only DECIDES the steps; the order's state changes are in orders.service.ts, the calls to
 * other services in clients/. (M7 makes step 3 reliable with an outbox.)
 */
const inventoryDown = () =>
  new HttpError(503, "inventory_unavailable", "We couldn't check stock right now (the inventory service is unavailable). Nothing was charged - please try again in a moment.");

export async function checkout(userId: string, paymentMethod: PaymentMethod, idem?: { key: string; fingerprint: string }) {
  // 1. local transaction (or an idempotent replay of an order placed before)
  const placed = await ordersService.placeOrReplay(userId, paymentMethod, idem);
  const order = await ordersService.getForUser(userId, placed.orderId);
  if (placed.replayed) return { order, replayed: true };

  // 2. reserve the stock
  const reserve = await reserveStock(order.id, order.items);
  if (reserve.outcome === "insufficient_stock" || reserve.outcome === "unreachable" || reserve.outcome === "rejected") {
    await ordersService.undoPlacement(order.id, userId); // compensation: as if the order never existed
    if (reserve.outcome !== "insufficient_stock") throw inventoryDown();
    const name = order.items.find((i) => i.productId === reserve.productId)?.name ?? "An item";
    throw conflict("insufficient_stock", reserve.available === 0 ? `"${name}" is out of stock` : `Only ${reserve.available} left of "${name}"`);
  }
  if (reserve.outcome !== "reserved") {
    // Outcome unknown: stock MAY be reserved. Compensate twice over: cancel (cart restored, key
    // freed so a retry is a fresh attempt), release now (best effort) AND publish OrderCancelled,
    // which the inventory service handles even if it is down right now.
    const cancelled = await ordersService.cancel(order.id, "inventory_unavailable", "PENDING");
    if (cancelled) {
      await releaseReservation(order.id);
      await publishEvent(ORDERS_TOPIC, orderEvents.cancelled(cancelled, userId));
    }
    throw inventoryDown();
  }

  // 3. hand over to the payment service. NOT awaited: the customer's answer must not wait for the
  // broker. If this publish is lost, the RECONCILER re-publishes it (reconciler.ts).
  void publishEvent(ORDERS_TOPIC, orderEvents.created(order, userId, paymentMethod));
  return { order, replayed: false }; // 4. status PENDING
}
