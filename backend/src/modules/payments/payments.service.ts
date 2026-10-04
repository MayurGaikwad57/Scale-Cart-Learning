import { randomUUID } from "node:crypto";
import { Prisma } from "../../../generated/prisma/client.js";

// There is no real payment provider in Phase 1. The "method" is a test card chosen at checkout
// so both outcomes can be exercised from the UI. Phase 4 extracts this into its own service.
export const PAYMENT_METHODS = ["TEST_CARD_SUCCESS", "TEST_CARD_DECLINE"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const paymentsService = {
  // Runs inside the caller's transaction (tx), so the payment row commits or rolls back with the order.
  async charge(
    tx: Prisma.TransactionClient,
    input: { orderId: string; amountCents: number; method: PaymentMethod },
  ) {
    const succeeded = input.method === "TEST_CARD_SUCCESS";
    return tx.payment.create({
      data: {
        orderId: input.orderId,
        amountCents: input.amountCents,
        status: succeeded ? "SUCCEEDED" : "FAILED",
        providerRef: `sim_${randomUUID()}`,
      },
    });
  },
};
