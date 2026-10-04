import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { errorMessage } from '../../core/http-error';
import { PaymentMethod } from '../../core/models';
import { CartService } from '../../core/services/cart.service';
import { OrdersService } from '../../core/services/orders.service';
import { MoneyPipe } from '../../shared/pipes/money.pipe';

@Component({
  selector: 'app-checkout-page',
  imports: [ReactiveFormsModule, RouterLink, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="h3 mb-3">Checkout</h1>

    @if (cart.items().length === 0) {
      <div class="card card-body text-center py-5 shadow-sm">
        <p class="mb-3 text-muted">There is nothing to check out.</p>
        <div><a routerLink="/products" class="btn btn-primary">Browse products</a></div>
      </div>
    } @else {
      @if (error()) {
        <div class="alert alert-danger" role="alert">
          {{ error() }} <a routerLink="/cart" class="alert-link ms-1">Review cart</a>
        </div>
      }
      <div class="row g-4">
        <div class="col-lg-7">
          <div class="card shadow-sm">
            <div class="card-body">
              <h2 class="h5">Payment</h2>
              <p class="small text-muted">
                No real payment provider yet. Pick a <strong>test card</strong> to see both outcomes: success confirms the order,
                decline cancels it and gives the reserved stock back.
              </p>
              <form [formGroup]="form" (ngSubmit)="place()">
                <div class="form-check mb-2">
                  <input class="form-check-input" type="radio" id="pm-ok" formControlName="paymentMethod" value="TEST_CARD_SUCCESS" />
                  <label class="form-check-label" for="pm-ok">Test card: payment succeeds ✅</label>
                </div>
                <div class="form-check mb-3">
                  <input class="form-check-input" type="radio" id="pm-fail" formControlName="paymentMethod" value="TEST_CARD_DECLINE" />
                  <label class="form-check-label" for="pm-fail">Test card: payment is declined ❌</label>
                </div>
                <button class="btn btn-primary" type="submit" [disabled]="placing()">
                  {{ placing() ? 'Placing order…' : 'Place order · ' + (cart.totalCents() | money) }}
                </button>
              </form>
            </div>
          </div>
        </div>
        <div class="col-lg-5">
          <div class="card shadow-sm">
            <div class="card-body">
              <h2 class="h5">Order summary</h2>
              <ul class="list-unstyled mb-3">
                @for (item of cart.items(); track item.id) {
                  <li class="d-flex justify-content-between small py-1">
                    <span>{{ item.quantity }} × {{ item.name }}</span><span>{{ item.lineTotalCents | money }}</span>
                  </li>
                }
              </ul>
              <div class="d-flex justify-content-between fw-semibold border-top pt-2"><span>Total</span><span>{{ cart.totalCents() | money }}</span></div>
            </div>
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
