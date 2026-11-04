import { env } from "../../config/env.js";
import { serviceUrls, type ServiceName } from "../registry.js";
import { INTERNAL_TOKEN_HEADER } from "./internal-auth.js";
import { currentRequestId, REQUEST_ID_HEADER } from "./request-context.js";

/**
 * A SYNCHRONOUS call from one service to another over HTTP.
 *
 * Inside a monolith, `inventoryService.reserve()` is a function call: it either returns or throws,
 * and it never "half happens". Over the network there is a THIRD outcome, and it is the one that
 * makes distributed systems hard:
 *
 *   answer received (2xx/4xx)  -> we KNOW what happened
 *   connection refused         -> the other side never got the request: we know NOTHING happened
 *   timeout / 5xx / reset      -> UNKNOWN: it may have happened, or not. The request may even still
 *                                 be running over there while we have given up.
 *
 * So every call has a TIMEOUT (never wait forever - a slow dependency would make us slow too), and
 * the error tells the caller whether the outcome is unknown, so it can clean up safely.
 */
export class ServiceCallError extends Error {
  constructor(
    readonly service: ServiceName,
    /** "unreachable" = definitely not processed; "timeout"/"server_error" = outcome unknown. */
    readonly kind: "unreachable" | "timeout" | "server_error",
    message: string,
  ) {
    super(message);
  }
  get outcomeUnknown() {
    return this.kind !== "unreachable";
  }
}

export interface ServiceResponse<T> {
  status: number;
  body: T;
}

export async function callService<T = unknown>(
  service: ServiceName,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<ServiceResponse<T>> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const headers: Record<string, string> = { [INTERNAL_TOKEN_HEADER]: env.INTERNAL_TOKEN };
  const requestId = currentRequestId();
  if (requestId) headers[REQUEST_ID_HEADER] = requestId; // keep the correlation chain going
  if (body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(serviceUrls[service] + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    if (err.name === "TimeoutError") throw new ServiceCallError(service, "timeout", `${service} service did not answer within ${timeoutMs}ms`);
    if (err.cause?.code === "ECONNREFUSED") throw new ServiceCallError(service, "unreachable", `${service} service is not running`);
    // Connection reset mid-request etc.: the request may have arrived.
    throw new ServiceCallError(service, "server_error", `${service} service call failed: ${err.cause?.code ?? err.message}`);
  }
  let parsed: T;
  try {
    const text = await res.text(); // the timeout also covers reading the body
    parsed = (text ? JSON.parse(text) : undefined) as T;
  } catch (e) {
    const kind = (e as Error).name === "TimeoutError" ? "timeout" : "server_error";
    throw new ServiceCallError(service, kind, `${service} service sent an unreadable answer: ${(e as Error).message}`);
  }
  if (res.status >= 500) throw new ServiceCallError(service, "server_error", `${service} service answered ${res.status}`);
  return { status: res.status, body: parsed };
}
