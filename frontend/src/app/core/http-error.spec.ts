import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import { errorMessage } from './http-error';
import { safeReturnUrl } from '../features/auth/return-url';

const http = (status: number, error: unknown) => new HttpErrorResponse({ status, error });

describe('errorMessage', () => {
  it('explains a dead backend', () => {
    expect(errorMessage(http(0, null))).toContain('backend');
  });
  it('maps known codes to friendly text', () => {
    expect(errorMessage(http(401, { error: 'invalid_credentials' }))).toBe('Wrong email or password.');
    expect(errorMessage(http(409, { error: 'email_taken' }))).toContain('already exists');
  });
  it('shows the server message for stock problems', () => {
    expect(errorMessage(http(409, { error: 'insufficient_stock', message: 'Only 1 left of "Watch"' }))).toBe('Only 1 left of "Watch"');
  });
  it('lists validation problems per field', () => {
    const msg = errorMessage(http(400, { error: 'validation_failed', details: [{ path: 'email', message: 'Invalid email' }] }));
    expect(msg).toBe('email: Invalid email');
  });
  it('never leaks non-HTTP errors', () => {
    expect(errorMessage(new Error('boom: secret'))).toBe('Something went wrong. Please try again.');
  });
});

describe('safeReturnUrl (open-redirect protection)', () => {
  it('allows in-app paths', () => {
    expect(safeReturnUrl('/orders/123?placed=1')).toBe('/orders/123?placed=1');
  });
  it('rejects external and protocol-relative URLs', () => {
    expect(safeReturnUrl('https://evil.com')).toBe('/');
    expect(safeReturnUrl('//evil.com')).toBe('/');
    expect(safeReturnUrl(null)).toBe('/');
  });
});
