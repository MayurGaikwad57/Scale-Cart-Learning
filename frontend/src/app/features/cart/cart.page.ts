import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Observable } from 'rxjs';
import { errorMessage } from '../../core/http-error';
import { CartItem } from '../../core/models';
import { CartService } from '../../core/services/cart.service';
import { ToastService } from '../../core/services/toast.service';
import { Icon } from '../../shared/components/icon';
import { ProductArt } from '../../shared/components/product-art';
import { MoneyPipe } from '../../shared/pipes/money.pipe';

@Component({
  selector: 'app-cart-page',
  imports: [RouterLink, MoneyPipe, Icon, ProductArt],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-4">
      <div class="sc-eyebrow">Shopping cart</div>
      <h1 class="sc-page-title">
        Your cart @if (cart.count() > 0) { <span class="sc-muted fw-semibold fs-5">· {{ cart.count() }} item{{ cart.count() === 1 ? '' : 's' }}</span> }
      </h1>
    </div>

    @if (cart.items().length === 0) {
      <div class="sc-card sc-empty">
        <div class="sc-empty-icon"><app-icon name="cart" [size]="32" /></div>
        <h2 class="h5">Your cart is empty</h2>
        <p class="sc-muted">Looks like you haven't added anything yet.</p>
        <a routerLink="/products" class="sc-btn sc-btn-primary">Browse products <app-icon name="arrowRight" [size]="18" /></a>
      </div>
    } @else {
      @if (cart.hasUnavailableItems()) {
        <div class="sc-alert sc-alert-warn mb-3" role="alert">
          <app-icon name="alert" [size]="20" />
          <span>Some items have more quantity than we have in stock (or are no longer sold). Adjust them to continue to checkout.</span>
        </div>
      }
      <div class="row g-4">
        <div class="col-lg-8">
          <div class="sc-card overflow-hidden">
            @for (item of cart.items(); track item.id) {
              <div class="sc-line-item" [style.opacity]="busyId() === item.id ? 0.55 : 1">
                <app-product-art class="sc-thumb" [sku]="item.sku" [category]="item.category" />
                <div class="flex-grow-1" style="min-width: 160px">
                  <a [routerLink]="['/products', item.productId]" class="fw-semibold text-reset d-block">{{ item.name }}</a>
                  <div class="sc-muted small">{{ item.priceCents | money }} each</div>
                  @if (!item.purchasable) {
                    <div class="small fw-semibold" style="color: var(--sc-danger)">{{ item.stock === 0 ? 'Out of stock' : 'Only ' + item.stock + ' available' }}</div>
                  }
                </div>
                <div class="sc-qty sc-qty-sm" role="group" [attr.aria-label]="'Quantity for ' + item.name">
                  <button type="button" aria-label="Decrease" [disabled]="busyId() === item.id || item.quantity <= 1" (click)="changeQty(item, item.quantity - 1)"><app-icon name="minus" [size]="15" /></button>
                  <span class="sc-qty-val" data-testid="qty">{{ item.quantity }}</span>
                  <button type="button" aria-label="Increase" [disabled]="busyId() === item.id || item.quantity >= item.stock" (click)="changeQty(item, item.quantity + 1)"><app-icon name="plus" [size]="15" /></button>
                </div>
                <div class="fw-bold text-end" style="min-width: 108px">{{ item.lineTotalCents | money }}</div>
                <button type="button" class="sc-iconbtn" style="color: var(--sc-danger)" [disabled]="busyId() === item.id" [attr.aria-label]="'Remove ' + item.name" (click)="remove(item)">
                  <app-icon name="trash" [size]="19" />
                </button>
              </div>
            }
          </div>
          <a routerLink="/products" class="sc-btn sc-btn-ghost mt-3"><app-icon name="arrowLeft" [size]="17" /> Continue shopping</a>
        </div>

        <div class="col-lg-4">
          <div class="sc-card sc-card-pad sc-summary">
            <h2 class="h5 mb-3">Order summary</h2>
            <div class="sc-summary-row"><span>Items ({{ cart.count() }})</span><span>{{ cart.totalCents() | money }}</span></div>
            <div class="sc-summary-row"><span>Shipping</span><span class="sc-muted">Not applicable (demo)</span></div>
            <div class="sc-total"><span>Total</span><span data-testid="cart-total">{{ cart.totalCents() | money }}</span></div>
            <a routerLink="/checkout" class="sc-btn sc-btn-primary sc-btn-lg sc-btn-block mt-3" [class.disabled]="cart.hasUnavailableItems()" [attr.aria-disabled]="cart.hasUnavailableItems()">
              Checkout <app-icon name="arrowRight" [size]="18" />
            </a>
            <div class="sc-muted small text-center mt-3 d-flex align-items-center justify-content-center gap-2"><app-icon name="lock" [size]="14" /> Secure, validated checkout</div>
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

  private run(id: string, request: Observable<unknown>): void {
    this.busyId.set(id);
    request.subscribe({
      next: () => this.busyId.set(null),
      error: (e) => {
        this.toast.show(errorMessage(e), 'danger', 4500);
        this.busyId.set(null);
        this.cart.refresh().subscribe({ error: () => undefined }); // resync with the server's truth
      },
    });
  }
}
