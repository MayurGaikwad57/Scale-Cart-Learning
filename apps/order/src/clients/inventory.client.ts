import { callService, ServiceCallError } from "@scalecart/service-kit/http-client";

/**
 * The order service's ONLY door to the inventory service (synchronous HTTP). Callers get what we
 * KNOW about the outcome - never a raw HTTP status - so the saga can decide on compensations.
 *   reserved            stock is held
 *   insufficient_stock  answered: not enough (nothing reserved)
 *   released            answered: this order is already dead (tombstone)
 *   rejected            answered with another 4xx (nothing reserved)
 *   unreachable         connection refused: it never got the request (nothing reserved)
 *   unknown             timeout / 5xx / reset: it MAY have reserved
 */
export type ReserveOutcome = "reserved" | "insufficient_stock" | "released" | "rejected" | "unknown" | "unreachable";

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
    // That is a definite "nothing was reserved", not an unknown outcome.
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

/** Best effort: give the stock of a dead order back now (the OrderCancelled event does it too). */
export async function releaseReservation(orderId: string) {
  await callService("inventory", "POST", `/internal/reservations/${orderId}/release`, undefined, { timeoutMs: 1000 }).catch(() => undefined);
}
