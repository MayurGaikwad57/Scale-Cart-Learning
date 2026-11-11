import type { RequestHandler } from "express";
import type { ZodType } from "zod";

// Parses req.body with a zod schema. On failure zod throws and errorHandler returns a 400.
// On success the body is replaced by the parsed (typed, cleaned) value.
export const validateBody =
  (schema: ZodType): RequestHandler =>
  (req, _res, next) => {
    req.body = schema.parse(req.body);
    next();
  };
