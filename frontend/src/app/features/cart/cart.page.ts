import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../core/http-error';
import { CartItem } from '../../core/models';
import { CartService } from '../../core/services/cart.service';
import { ToastService } from '../../core/services/toast.service';
import { MoneyPipe } from '../../shared/pipes/money.pipe';

@Component({
  selector: 'app-cart-page',
  imports: [RouterLink, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="h3 mb-3">Your cart</h1>

    @if (cart.items().length === 0) {
      <div class="card card-body text-center py-5 shadow-sm">
        <p class="mb-3 text-muted">Your cart is empty.</p>
        <div><a routerLink="/products" class="btn btn-primary">Browse products</a></div>
      </div>
    } @else {
      @if (cart.hasUnavailableItems()) {
        <div class="alert alert-warning" role="alert">
          Some items have more quantity than we have in stock (or are no longer sold). Adjust them before checkout.
        </div>
      }
      <div class="row g-4">
        <div class="col-lg-8">
          <div class="list-group shadow-sm">
            @for (item of cart.items(); track item.id) {
              <div class="list-group-item p-3">
                <div class="d-flex flex-wrap gap-3 align-items-center">
                  <div class="flex-grow-1">
                    <a [routerLink]="['/products', item.productId]" class="fw-semibold text-reset">{{ item.name }}</a>
                    <div class="small text-muted">{{ item.priceCents | money }} each</div>
                    @if (!item.purchasable) {
                      <div class="small text-danger">Only {{ item.stock }} available</div>
                    }
                  </div>
                  <div class="btn-group" role="group" [attr.aria-label]="'Quantity for ' + item.name">
                    <button class="btn btn-outline-secondary btn-sm" [disabled]="busyId() === item.id || item.quantity <= 1"
                      (click)="changeQty(item, item.quantity - 1)" aria-label="Decrease">−</button>
                    <span class="btn btn-sm disabled border text-dark px-3" data-testid="qty">{{ item.quantity }}</span>
                    <button class="btn btn-outline-secondary btn-sm" [disabled]="busyId() === item.id || item.quantity >= item.stock"
                      (click)="changeQty(item, item.quantity + 1)" aria-label="Increase">+</button>
                  </div>
                  <div class="fw-semibold text-end" style="min-width: 110px">{{ item.lineTotalCents | money }}</div>
                  <button class="btn btn-link text-danger btn-sm" [disabled]="busyId() === item.id" (click)="remove(item)">Remove</button>
                </div>
              </div>
            }
          </div>
        </div>
        <div class="col-lg-4">
          <div class="card shadow-sm">
            <div class="card-body">
              <h2 class="h5">Summary</h2>
              <div class="d-flex justify-content-between"><span>Items</span><span>{{ cart.count() }}</span></div>
              <hr />
              <div class="d-flex justify-content-between fs-5 fw-semibold mb-3">
                <span>Total</span><span data-testid="cart-total">{{ cart.totalCents() | money }}</span>
              </div>
              <a routerLink="/checkout" class="btn btn-primary w-100" [class.disabled]="cart.hasUnavailableItems()"
                [attr.aria-disabled]="cart.hasUnavailableItems()">Proceed to checkout</a>
            </div>
          </div>
        </div>
      </div>
    }
  `,
})
export class CartPage {
  protected readonly cart = inject(CartService);
  private readonly toast = inject(ToastService);
  protected readonly busyId = signal<string | null>(null);

  protected changeQty(item: CartItem, quantity: number): void {
    this.run(item.id, this.cart.setQuantity(item.id, quantity));
  }

  protected remove(item: CartItem): void {
    this.run(item.id, this.cart.remove(item.id));
  }

  private run(id: string, request: ReturnType<CartService['remove']>): void {
    this.busyId.set(id);
    request.subscribe({
      next: () => this.busyId.set(null),
      error: (e) => {
        this.toast.show(errorMessage(e), 'danger', 4000);
        this.busyId.set(null);
        this.cart.refresh().subscribe({ error: () => undefined }); // resync with the server's truth
      },
    });
  }
}
