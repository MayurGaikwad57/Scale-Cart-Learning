import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { errorMessage } from '../../core/http-error';
import { PaymentMethod } from '../../core/models';
import { CartService } from '../../core/services/cart.service';
import { OrdersService } from '../../core/services/orders.service';
import { Icon } from '../../shared/components/icon';
import { ProductArt } from '../../shared/components/product-art';
import { MoneyPipe } from '../../shared/pipes/money.pipe';

@Component({
  selector: 'app-checkout-page',
  imports: [ReactiveFormsModule, RouterLink, MoneyPipe, Icon, ProductArt],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-4">
      <ol class="sc-stepper mb-3" aria-label="Checkout progress">
        <li class="sc-step done"><span class="sc-step-dot"><app-icon name="check" [size]="15" /></span> Cart</li>
        <li class="sc-step-bar done"></li>
        <li class="sc-step current"><span class="sc-step-dot">2</span> Payment</li>
        <li class="sc-step-bar"></li>
        <li class="sc-step"><span class="sc-step-dot">3</span> Confirmation</li>
      </ol>
      <h1 class="sc-page-title">Checkout</h1>
    </div>

    @if (cart.items().length === 0) {
      <div class="sc-card sc-empty">
        <div class="sc-empty-icon"><app-icon name="cart" [size]="32" /></div>
        <h2 class="h5">There is nothing to check out</h2>
        <a routerLink="/products" class="sc-btn sc-btn-primary mt-2">Browse products</a>
      </div>
    } @else {
      @if (error()) {
        <div class="sc-alert sc-alert-danger mb-3" role="alert">
          <app-icon name="alert" [size]="20" />
          <span>{{ error() }} <a routerLink="/cart">Review your cart</a></span>
        </div>
      }
      <div class="row g-4">
        <div class="col-lg-7">
          <form [formGroup]="form" (ngSubmit)="place()" class="sc-card sc-card-pad">
            <h2 class="h5 mb-1">Payment method</h2>
            <p class="sc-muted small mb-3">
              This is a demo store with no real payment provider. Choose a <b>test card</b> to see what happens in each case.
            </p>

            <div class="d-grid gap-3 mb-4">
              <label class="sc-option">
                <input type="radio" formControlName="paymentMethod" value="TEST_CARD_SUCCESS" />
                <span class="sc-option-icon" style="background: var(--sc-success-50); color: var(--sc-success)"><app-icon name="checkCircle" [size]="22" /></span>
                <span><b class="d-block">Test card: payment succeeds</b><span class="sc-muted small">The order is confirmed and your stock is sold to you.</span></span>
                <span class="sc-radio"><app-icon name="check" [size]="14" /></span>
              </label>
              <label class="sc-option">
                <input type="radio" formControlName="paymentMethod" value="TEST_CARD_DECLINE" />
                <span class="sc-option-icon" style="background: var(--sc-danger-50); color: var(--sc-danger)"><app-icon name="xCircle" [size]="22" /></span>
                <span><b class="d-block">Test card: payment is declined</b><span class="sc-muted small">The order is cancelled and the reserved stock is released.</span></span>
                <span class="sc-radio"><app-icon name="check" [size]="14" /></span>
              </label>
            </div>

            <button class="sc-btn sc-btn-primary sc-btn-lg sc-btn-block" type="submit" [disabled]="placing()">
              @if (placing()) { <span class="sc-spinner"></span> Placing your order… } @else { <app-icon name="lock" [size]="18" /> Place order · {{ cart.totalCents() | money }} }
            </button>
          </form>
        </div>

        <div class="col-lg-5">
          <div class="sc-card sc-card-pad sc-summary">
            <div class="d-flex justify-content-between align-items-center mb-3">
              <h2 class="h5 mb-0">Order summary</h2>
              <a routerLink="/cart" class="small fw-semibold">Edit cart</a>
            </div>
            @for (item of cart.items(); track item.id) {
              <div class="d-flex align-items-center gap-3 py-2">
                <app-product-art class="sc-thumb-sm" [sku]="item.sku" [category]="item.category" />
                <div class="flex-grow-1 small"><div class="fw-semibold">{{ item.name }}</div><div class="sc-muted">Qty {{ item.quantity }}</div></div>
                <div class="fw-semibold small">{{ item.lineTotalCents | money }}</div>
              </div>
            }
            <div class="sc-total"><span>Total</span><span>{{ cart.totalCents() | money }}</span></div>
          </div>
        </div>
      </div>
    }
  `,
})
export class CheckoutPage {
  protected readonly cart = inject(CartService);
  private readonly orders = inject(OrdersService);
  private readonly router = inject(Router);

  protected readonly form = inject(NonNullableFormBuilder).group({
    paymentMethod: ['TEST_CARD_SUCCESS' as PaymentMethod, Validators.required],
  });
  protected readonly placing = signal(false);
  protected readonly error = signal<string | null>(null);

  protected place(): void {
    if (this.placing()) return; // the button is disabled too; this also blocks a keyboard double-submit
    this.placing.set(true);
    this.error.set(null);
    this.orders.place(this.form.controls.paymentMethod.value).subscribe({
      next: (order) => void this.router.navigate(['/orders', order.id], { queryParams: { placed: 1 } }),
      error: (e) => {
        this.error.set(errorMessage(e));
        this.placing.set(false);
        this.cart.refresh().subscribe({ error: () => undefined }); // stock may have changed
      },
    });
  }
}
