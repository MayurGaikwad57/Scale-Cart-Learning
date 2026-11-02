import { createHash } from "node:crypto";
import { z } from "zod";
import { kv } from "../config/kv.js";
import { HttpError } from "../utils/errors.js";

/**
 * IDEMPOTENCY: "doing it twice has the same effect as doing it once".
 *
 * The problem: the client sends "place order", the server places it, but the response is lost
 * (Wi-Fi drop, timeout, proxy restart). The client can't know whether the order exists. If it
 * retries, it might order twice. With an Idempotency-Key header the client says "this is the
 * SAME attempt as before"; the server then returns the first result instead of acting again.
 *
 * The record in ScaleKV goes through two states:
 *
 *   SET idem:<scope>:<key> {"state":"running","fp":...} NX PX 60000
 *        |-- NX failed -> someone already used this key:
 *        |        running  -> 409 request_in_progress   (the first attempt is still working)
 *        |        done     -> replay the stored response (same status + body, no new order)
 *        |        other fp -> 422 idempotency_key_reused (same key, DIFFERENT request body = client bug)
 *        |-- NX succeeded -> run the handler, then store {"state":"done", status, body} for 24h
 *                            (if the handler threw, delete the record so the client may retry)
 *
 * ScaleKV is the FAST layer, not the only one: the record can be lost (ScaleKV restarted,
 * evicted, down). That's why order creation ALSO stores the key on the order row with a UNIQUE
 * constraint - the database is the final guarantee. See orders.service.ts.
 */

export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,100}$/, "Idempotency-Key must be 8-100 characters: letters, digits, - or _")
  .optional();

const RUNNING_TTL_MS = 60_000; // longer than the checkout transaction timeout (10s)
const DONE_TTL_MS = 24 * 60 * 60_000; // how long a retry can still get the original answer

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

type IdemRecord =
  | { state: "running"; fp: string }
  | { state: "done"; fp: string; status: number; body: unknown };

export const fingerprint = (body: unknown) => createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");

export async function withIdempotency<T>(opts: {
  scope: string; // e.g. "order:<userId>" - keys of different users never collide
  key: string | undefined;
  fingerprint: string;
  run: () => Promise<IdempotentResult<T>>;
}): Promise<IdempotentResult<T>> {
  if (!opts.key || !kv.isReady) return opts.run();
  const kvKey = `idem:${opts.scope}:${opts.key}`;

  let acquired: boolean;
  try {
    acquired = await kv.set(kvKey, JSON.stringify({ state: "running", fp: opts.fingerprint }), { pxMs: RUNNING_TTL_MS, nx: true });
  } catch {
    return opts.run(); // ScaleKV hiccup: the database layer still prevents duplicates
  }

  if (!acquired) {
    const raw = await kv.get(kvKey).catch(() => null);
    if (raw) {
      const rec = JSON.parse(raw) as IdemRecord;
      if (rec.fp !== opts.fingerprint) {
        throw new HttpError(422, "idempotency_key_reused", "This Idempotency-Key was already used for a different request.");
      }
      if (rec.state === "running") {
        throw new HttpError(409, "request_in_progress", "The same request is still being processed. Please wait.");
      }
      return { status: rec.status, body: rec.body as T, replayed: true };
    }
    // The record vanished between SET and GET (expired). Fall through and run;
    // the database layer will still catch a true duplicate.
  }

  let result: IdempotentResult<T>;
  try {
    result = await opts.run();
  } catch (err) {
    await kv.del(kvKey).catch(() => undefined);
    throw err;
  }
  const done: IdemRecord = { state: "done", fp: opts.fingerprint, status: result.status, body: result.body };
  await kv.set(kvKey, JSON.stringify(done), { pxMs: DONE_TTL_MS }).catch(() => undefined);
  return result;
}
