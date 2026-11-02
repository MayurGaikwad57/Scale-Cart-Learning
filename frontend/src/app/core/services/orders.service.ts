import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, retry, tap, throwError, timer } from 'rxjs';
import { API_URL } from '../config';
import { Order, Page, PaymentMethod } from '../models';
import { CartService } from './cart.service';

const isInProgress = (e: unknown) => e instanceof HttpErrorResponse && e.error?.error === 'request_in_progress';
const isLostAnswer = (e: unknown) => e instanceof HttpErrorResponse && (e.status === 0 || e.status >= 500);

/**
 * "We don't know whether the order exists": the answer got lost (status 0 / 5xx), or the first
 * attempt is still running on the server (409 request_in_progress). In these cases the SAME
 * Idempotency-Key must be kept - the server will return the original order, never a second one.
 */
export const isUnknownOutcome = (e: unknown) => isInProgress(e) || isLostAnswer(e);

/**
 * How long to wait before asking again, or null to give up (exported for tests).
 *  - in progress: every 2s, up to 10 times (20s) - longer than the server can take
 *    (5s waiting for a DB connection + 10s transaction timeout), so the user gets the real result.
 *  - lost answer: twice, 0.5s then 1s apart.
 */
export function retryDelayMs(e: unknown, attempt: number): number | null {
  if (isInProgress(e) && attempt <= 10) return 2000;
  if (isLostAnswer(e) && attempt <= 2) return 500 * attempt;
  return null;
}

@Injectable({ providedIn: 'root' })
export class OrdersService {
  private readonly http = inject(HttpClient);
  private readonly cart = inject(CartService);

  /**
   * Checkout. `idempotencyKey` identifies this ONE purchase attempt (see CheckoutPage).
   * Afterwards the server has emptied (or kept) the cart, so reload it.
   */
  place(paymentMethod: PaymentMethod, idempotencyKey: string): Observable<Order> {
    return this.http
      .post<Order>(`${API_URL}/orders`, { paymentMethod }, { headers: { 'Idempotency-Key': idempotencyKey } })
      .pipe(
        // Automatic retries for "unknown outcome" errors only (see retryDelayMs).
        retry({
          count: 10,
          delay: (err, attempt) => {
            const ms = retryDelayMs(err, attempt);
            return ms === null ? throwError(() => err) : timer(ms);
          },
        }),
        tap(() => this.cart.refresh().subscribe({ error: () => undefined })),
      );
  }

  list(page: number, pageSize = 10): Observable<Page<Order>> {
    const params = new HttpParams().set('page', page).set('pageSize', pageSize);
    return this.http.get<Page<Order>>(`${API_URL}/orders`, { params });
  }

  get(id: string): Observable<Order> {
    return this.http.get<Order>(`${API_URL}/orders/${id}`);
  }
}
