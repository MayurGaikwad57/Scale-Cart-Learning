import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, retry, tap, throwError, timer } from 'rxjs';
import { API_URL } from '../config';
import { Order, Page, PaymentMethod } from '../models';
import { CartService } from './cart.service';

/**
 * Is it safe and useful to send the same checkout again?
 *  - status 0 / 5xx: we don't know if the order was created (the answer got lost).
 *  - 409 request_in_progress: the first attempt is still running on the server.
 * Safe ONLY because every retry carries the SAME Idempotency-Key: the server returns the
 * original order instead of creating a second one.
 */
const isRetryable = (e: unknown) =>
  e instanceof HttpErrorResponse && (e.status === 0 || e.status >= 500 || e.error?.error === 'request_in_progress');

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
        // Up to 2 automatic retries, 0.5s then 1s apart, for "unknown outcome" errors only.
        retry({ count: 2, delay: (err, attempt) => (isRetryable(err) ? timer(500 * attempt) : throwError(() => err)) }),
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
