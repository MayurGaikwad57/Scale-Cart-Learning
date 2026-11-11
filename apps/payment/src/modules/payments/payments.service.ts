import { createHash } from "node:crypto";
import { env } from "../../config/env.js";
import { prisma } from "../../config/prisma.js";

// There is no real payment provider. The "method" is a test card chosen at checkout so both
// outcomes can be exercised from the UI. The list is part of the order<->payment CONTRACT.
import { PAYMENT_METHODS, type PaymentMethod } from "@scalecart/events";

export { PAYMENT_METHODS, type PaymentMethod };

/** Tunable at runtime (tests set it to 0). Defaults to PAYMENT_DELAY_MS. */
export const paymentSettings = { providerDelayMs: env.PAYMENT_DELAY_MS };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The (simulated) external payment provider - think Razorpay / Stripe.
 *
 * Real providers accept an IDEMPOTENCY KEY: "if you have already seen this key, return the first
 * result instead of charging again". We pass the orderId. So even if OUR side crashes after the
 * provider charged but before we saved the result, asking again cannot charge the card twice.
 * The simulation honours that by deriving everything from the key (same key -> same answer).
 */
async function providerCharge(req: { idempotencyKey: string; amountCents: number; method: string }) {
  await sleep(paymentSettings.providerDelayMs); // network + bank latency
  const providerRef = "sim_" + createHash("sha256").update(req.idempotencyKey).digest("hex").slice(0, 24);
  if (req.method === "TEST_CARD_SUCCESS") return { status: "SUCCEEDED" as const, providerRef };
  if (req.method === "TEST_CARD_DECLINE") return { status: "FAILED" as const, providerRef, reason: "card_declined" };
  return { status: "FAILED" as const, providerRef, reason: "unsupported_method" };
}

/**
 * Why a payment failed. Derived from the stored method, so a DUPLICATE delivery (which returns the
 * saved row instead of calling the provider again) reports the same reason as the first one
 * (found in code review: it always said "card_declined").
 */
export const failureReason = (method: string | null) =>
  (PAYMENT_METHODS as readonly string[]).includes(method ?? "") ? "card_declined" : "unsupported_method";

export const paymentsService = {
  /**
   * Charge an order AT MOST ONCE, however many times its OrderCreated event arrives.
   *   1. Already have a payment row for this order? Return it - no second charge.
   *   2. Otherwise call the provider (OUTSIDE any DB transaction: never hold a database
   *      transaction/locks open while waiting seconds for an external system).
   *   3. Save the result. The UNIQUE(order_id) constraint is the last line of defence: if two
   *      deliveries raced through step 1, the second insert fails and we return the first row.
   */
  async chargeOnce(input: { orderId: string; amountCents: number; method: string }) {
    const existing = await prisma.payment.findUnique({ where: { orderId: input.orderId } });
    if (existing) return { payment: existing, duplicate: true };

    const result = await providerCharge({ idempotencyKey: input.orderId, amountCents: input.amountCents, method: input.method });
    try {
      const payment = await prisma.payment.create({
        data: { orderId: input.orderId, amountCents: input.amountCents, status: result.status, providerRef: result.providerRef, method: input.method },
      });
      return { payment, duplicate: false, reason: result.reason };
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e;
      return { payment: await prisma.payment.findUniqueOrThrow({ where: { orderId: input.orderId } }), duplicate: true };
    }
  },

  async overview() {
    const [byStatus, recent] = await Promise.all([
      prisma.payment.groupBy({ by: ["status"], _count: { _all: true }, _sum: { amountCents: true } }),
      prisma.payment.findMany({ orderBy: { createdAt: "desc" }, take: 15 }),
    ]);
    return {
      providerDelayMs: paymentSettings.providerDelayMs,
      totals: byStatus.map((s) => ({ status: s.status, count: s._count._all, amountCents: s._sum.amountCents ?? 0 })),
      recent: recent.map((p) => ({
        id: p.id,
        orderId: p.orderId,
        amountCents: p.amountCents,
        status: p.status,
        method: p.method,
        providerRef: p.providerRef,
        createdAt: p.createdAt,
      })),
    };
  },
};
