import { HttpErrorResponse } from '@angular/common/http';

// Turns any backend error ({ error, message?, details? }) into text a user can read.
export function errorMessage(err: unknown): string {
  if (!(err instanceof HttpErrorResponse)) return 'Something went wrong. Please try again.';
  if (err.status === 0) return 'Cannot reach the server. Is the backend running on port 3000?';

  const body = err.error as { error?: string; message?: string; details?: { path: string; message: string }[] } | null;
  if (body?.error === 'validation_failed' && body.details?.length) {
    return body.details.map((d) => `${d.path}: ${d.message}`).join('; ');
  }
  const friendly: Record<string, string> = {
    invalid_credentials: 'Wrong email or password.',
    email_taken: 'An account with this email already exists.',
    sku_taken: 'A product with this SKU already exists.',
    cart_empty: 'Your cart is empty.',
    idempotency_key_reused: 'This checkout attempt was already used with different details. Please try again.',
    request_in_progress: 'Your order is still being processed. Please wait a moment.',
  };
  if (body?.error && friendly[body.error]) return friendly[body.error];
  // 429: the server message says how long to wait ("... try again in 42 seconds").
  if (err.status === 429) return body?.message ?? 'Too many requests. Please wait a moment and try again.';
  // insufficient_stock / product_unavailable etc. carry a readable message from the server.
  if (body?.message && body.message !== body.error) return body.message;
  return body?.error?.replaceAll('_', ' ') ?? `Request failed (${err.status}).`;
}
