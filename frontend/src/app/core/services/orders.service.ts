import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { API_URL } from '../config';
import { Order, Page, PaymentMethod } from '../models';
import { CartService } from './cart.service';

@Injectable({ providedIn: 'root' })
export class OrdersService {
  private readonly http = inject(HttpClient);
  private readonly cart = inject(CartService);

  /** Checkout. Afterwards the server has emptied (or kept) the cart, so reload it. */
  place(paymentMethod: PaymentMethod): Observable<Order> {
    return this.http
      .post<Order>(`${API_URL}/orders`, { paymentMethod })
      .pipe(tap(() => this.cart.refresh().subscribe({ error: () => undefined })));
  }

  list(page: number, pageSize = 10): Observable<Page<Order>> {
    const params = new HttpParams().set('page', page).set('pageSize', pageSize);
    return this.http.get<Page<Order>>(`${API_URL}/orders`, { params });
  }

  get(id: string): Observable<Order> {
    return this.http.get<Order>(`${API_URL}/orders/${id}`);
  }
}
