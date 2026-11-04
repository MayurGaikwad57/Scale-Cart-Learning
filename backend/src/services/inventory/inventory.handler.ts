import type { OrderEvent } from "../../events/order-events.js";
import { reservations } from "./reservations.js";

/**
 * Consumer group "inventory" (runs in the Inventory Service) on the "orders" topic.
 *
 * The inventory service doesn't decide whether an order succeeds - the ORDER service owns that.
 * It just reacts to the facts the order service publishes:
 *   OrderConfirmed -> commit the reservation (units are sold) + refresh low-stock alerts
 *   OrderCancelled -> release it (units go back on sale)
 * Both are idempotent state transitions (see reservations.ts), so a duplicate event is harmless
 * without needing a processed_events marker.
 *
 * Old v1 OrderCreated events (M5) are ignored: in the monolith their stock was already settled
 * inside the checkout transaction.
 */
export async function inventoryHandler(e: OrderEvent) {
  if (e.type === "OrderConfirmed") return reservations.commit(e.data.orderId);
  if (e.type === "OrderCancelled") return reservations.release(e.data.orderId);
  return "skipped";
}
