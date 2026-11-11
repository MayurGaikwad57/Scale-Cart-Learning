/**
 * IDEMPOTENT CONSUMER: do `work` at most once per (group, event), even if the event is delivered
 * many times. The marker row and the work are written in ONE transaction of the service's database:
 *   - both commit -> done; a redelivery hits the primary key and is skipped;
 *   - the work throws -> both roll back -> the retry starts clean.
 * This turns at-least-once DELIVERY into exactly-once EFFECT (for effects inside that database).
 *
 * The LOGIC lives here once; each service only says how to open a transaction on ITS database
 * (it needs a `processed_events` table):
 *     export const once = createOnce<Prisma.TransactionClient>((work) => prisma.$transaction(work));
 */
export interface ProcessedEventsTx {
  processedEvent: { create(args: { data: { consumerGroup: string; eventId: string } }): Promise<unknown> };
}

class AlreadyProcessed extends Error {}

export function createOnce<Tx extends ProcessedEventsTx>(inTransaction: <R>(fn: (tx: Tx) => Promise<R>) => Promise<R>) {
  return async function once(group: string, eventId: string, work: (tx: Tx) => Promise<void>): Promise<"done" | "duplicate"> {
    try {
      await inTransaction(async (tx) => {
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
  };
}
