// One error type for "expected" failures. The error middleware turns it into an HTTP response.
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code = "bad_request", msg?: string) => new HttpError(400, code, msg);
export const unauthorized = (code = "unauthorized", msg?: string) => new HttpError(401, code, msg);
export const forbidden = (code = "forbidden", msg?: string) => new HttpError(403, code, msg);
export const notFound = (code = "not_found", msg?: string) => new HttpError(404, code, msg);
export const conflict = (code = "conflict", msg?: string) => new HttpError(409, code, msg);
