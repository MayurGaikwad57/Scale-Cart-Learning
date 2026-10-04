import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../auth/auth.service';
import { errorMessage } from '../http-error';
import { Product } from '../models';
import { CartService } from './cart.service';
import { ToastService } from './toast.service';

/**
 * The "Add to cart" button behaves the same on every page (home, catalog, detail):
 * anonymous visitors are sent to log in and come back; otherwise add, then confirm with a toast.
 */
@Injectable({ providedIn: 'root' })
export class CartActionsService {
  private readonly auth = inject(AuthService);
  private readonly cart = inject(CartService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  /** Id of the product currently being added (to show a spinner / disable its button). */
  private readonly _busyId = signal<string | null>(null);
  readonly busyId = this._busyId.asReadonly();

  add(product: Product, quantity = 1): void {
    if (!this.auth.isLoggedIn()) {
      void this.router.navigate(['/login'], { queryParams: { returnUrl: this.router.url } });
      return;
    }
    this._busyId.set(product.id);
    this.cart.add(product.id, quantity).subscribe({
      next: () => {
        this.toast.show(quantity > 1 ? `Added ${quantity} × ${product.name} to your cart` : `${product.name} added to your cart`);
        this._busyId.set(null);
      },
      error: (e) => {
        this.toast.show(errorMessage(e), 'danger', 4500);
        this._busyId.set(null);
      },
    });
  }
}
