import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

/**
 * REQUEST CORRELATION. One click in the browser can now touch several processes:
 *   gateway -> order service -> inventory service -> (event) -> payment service ...
 * Without a shared id you cannot tell which log line in which terminal belongs to which click.
 *
 * The gateway gives every request an X-Request-Id (or keeps the one the client sent). Every
 * service reads it, puts it in its logs, sends it on with every HTTP call it makes, and copies it
 * into the headers of every event it publishes. In M9 (observability) this becomes a trace id.
 *
 * AsyncLocalStorage = a "thread-local" for async code: the id is available anywhere inside the
 * request's async call chain without passing it through every function.
 */
const store = new AsyncLocalStorage<{ requestId: string }>();

export const REQUEST_ID_HEADER = "x-request-id";

export const currentRequestId = () => store.getStore()?.requestId;

/** Runs `fn` with a request id in context (used by event consumers, which have no HTTP request). */
export const withRequestId = <T>(requestId: string | undefined, fn: () => T): T =>
  store.run({ requestId: requestId || randomUUID() }, fn);

const VALID_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

export const requestContext: RequestHandler = (req, res, next) => {
  const incoming = req.header(REQUEST_ID_HEADER);
  // Never trust a client-supplied value blindly: it ends up in logs (log injection).
  const requestId = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", requestId);
  store.run({ requestId }, next);
};
