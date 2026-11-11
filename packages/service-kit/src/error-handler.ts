import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError } from "./errors.js";

// Every error ends here, so clients always get the same JSON shape: { error, message?, details? }.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "validation_failed",
      details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  // Errors raised by Express's own body parser are the CLIENT's fault and say so: a 4xx status and
  // expose=true (malformed JSON -> 400 "entity.parse.failed", body over 100 KB -> 413
  // "entity.too.large"). Before, they fell through to 500 - "our bug" - which they are not.
  const e = err as { status?: unknown; expose?: unknown; type?: unknown };
  if (e.expose === true && typeof e.status === "number" && e.status >= 400 && e.status < 500) {
    return res.status(e.status).json({ error: typeof e.type === "string" ? e.type : "bad_request" });
  }
  // Unexpected: log the real error, never leak internals to the client.
  console.error(err);
  return res.status(500).json({ error: "internal_error" });
};
