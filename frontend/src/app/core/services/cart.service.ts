import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { API_URL } from '../config';
import { Cart } from '../models';

/**
 * STATE DECISION: the cart is a *Signal* in a root service because many unrelated places
 * need it at once (navbar badge, product cards, cart page, checkout). Everything the UI shows
 * is *derived* from the items with computed(), so the badge, the total and the warnings
 * can never disagree with each other.
 */
@Injectable({ providedIn: 'root' })
export class CartService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  private readonly _cart = signal<Cart | null>(null);
  readonly cart = this._cart.asReadonly();

  readonly items = computed(() => this._cart()?.items ?? []);
  readonly count = computed(() => this.items().reduce((n, i) => n + i.quantity, 0));
  readonly totalCents = computed(() => this.items().reduce((sum, i) => sum + i.lineTotalCents, 0));
  readonly hasUnavailableItems = computed(() => this.items().some((i) => !i.purchasable));

  constructor() {
    // effect(): when the login state changes, load that user's cart or clear it on logout.
    // untracked() stops the HTTP call's own signal writes from re-triggering this effect.
    effect(() => {
      const loggedIn = this.auth.isLoggedIn();
      untracked(() => {
        if (loggedIn) this.refresh().subscribe({ error: () => this._cart.set(null) });
        else this._cart.set(null);
      });
    });
  }

  refresh(): Observable<Cart> {
    return this.http.get<Cart>(`${API_URL}/cart`).pipe(tap((c) => this._cart.set(c)));
  }

  add(productId: string, quantity = 1): Observable<Cart> {
    return this.http.post<Cart>(`${API_URL}/cart/items`, { productId, quantity }).pipe(tap((c) => this._cart.set(c)));
  }

  setQuantity(itemId: string, quantity: number): Observable<Cart> {
    return this.http.put<Cart>(`${API_URL}/cart/items/${itemId}`, { quantity }).pipe(tap((c) => this._cart.set(c)));
  }

  remove(itemId: string): Observable<Cart> {
    return this.http.delete<Cart>(`${API_URL}/cart/items/${itemId}`).pipe(tap((c) => this._cart.set(c)));
  }
}
