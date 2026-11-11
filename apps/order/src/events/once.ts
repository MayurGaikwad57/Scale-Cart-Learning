import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../config/prisma.js";

/**
 * IDEMPOTENT CONSUMER: do `work` at most once per (group, event), even if the event is delivered
 * many times. The marker row and the work are written in ONE transaction of THIS service's database:
 *   - both commit -> done; a redelivery hits the primary key and is skipped;
 *   - the work throws -> both roll back -> the retry starts clean.
 * This turns at-least-once DELIVERY into exactly-once EFFECT (for effects inside our database).
 */
class AlreadyProcessed extends Error {}

export async function once(group: string, eventId: string, work: (tx: Prisma.TransactionClient) => Promise<void>): Promise<"done" | "duplicate"> {
  try {
    await prisma.$transaction(async (tx) => {
      try {
        await tx.processedEvent.create({ data: { consumerGroup: group, eventId } });
      } catch (e) {
        // ONLY a conflict on the marker itself means "already processed". A unique violation
        // raised by `work` is a real failure and must be retried / dead-lettered.
        if ((e as { code?: string }).code === "P2002") throw new AlreadyProcessed();
        throw e;
      }
      await work(tx);
    });
    return "done";
  } catch (e) {
    if (e instanceof AlreadyProcessed) return "duplicate";
    throw e;
  }
}
