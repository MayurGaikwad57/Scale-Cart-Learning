import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import { isUnknownOutcome, retryDelayMs } from './orders.service';

const http = (status: number, error: unknown = null) => new HttpErrorResponse({ status, error });
const inProgress = http(409, { error: 'request_in_progress' });

describe('checkout retry policy (safe because of the Idempotency-Key)', () => {
  it('treats lost answers and "still processing" as unknown outcomes (keep the key)', () => {
    expect(isUnknownOutcome(http(0))).toBe(true);
    expect(isUnknownOutcome(http(503))).toBe(true);
    expect(isUnknownOutcome(inProgress)).toBe(true);
    expect(isUnknownOutcome(http(409, { error: 'insufficient_stock' }))).toBe(false);
    expect(isUnknownOutcome(http(400, { error: 'cart_empty' }))).toBe(false);
  });

  it('keeps polling an in-progress order for longer than the server can take (15s)', () => {
    let waited = 0;
    for (let attempt = 1; retryDelayMs(inProgress, attempt) !== null; attempt++) waited += retryDelayMs(inProgress, attempt)!;
    expect(waited).toBeGreaterThan(15_000);
  });

  it('retries a lost answer twice with backoff, and never retries a clear answer', () => {
    expect([1, 2, 3].map((a) => retryDelayMs(http(0), a))).toEqual([500, 1000, null]);
    expect(retryDelayMs(http(409, { error: 'insufficient_stock' }), 1)).toBeNull();
    expect(retryDelayMs(http(429), 1)).toBeNull();
  });
});
