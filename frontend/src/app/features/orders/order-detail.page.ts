import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { catchError, map, of, startWith, switchMap } from 'rxjs';
import { errorMessage } from '../../core/http-error';
import { Order } from '../../core/models';
import { OrdersService } from '../../core/services/orders.service';
import { OrderStatusBadge } from '../../shared/components/order-status-badge';
import { MoneyPipe } from '../../shared/pipes/money.pipe';

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; order: Order };

// Doubles as the "Order confirmation" page: checkout redirects here with ?placed=1.
@Component({
  selector: 'app-order-detail-page',
  imports: [RouterLink, DatePipe, MoneyPipe, OrderStatusBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a routerLink="/orders" class="small">&larr; All orders</a>

    @switch (state().status) {
      @case ('loading') {
        <div class="text-center py-5"><div class="spinner-border" role="status"></div></div>
      }
      @case ('error') {
        <div class="alert alert-danger mt-3" role="alert">{{ errorText() }}</div>
      }
      @default {
        @if (order(); as o) {
          @if (placed()) {
            @if (o.status === 'CONFIRMED') {
              <div class="alert alert-success mt-3" role="status">
                <h2 class="h5 mb-1">🎉 Thank you! Your order is confirmed.</h2>
                Payment succeeded and your items are reserved for you.
              </div>
            } @else {
              <div class="alert alert-danger mt-3" role="alert">
                <h2 class="h5 mb-1">Payment was declined</h2>
                The order was cancelled and the reserved stock was released. Your cart is unchanged,
                so you can <a routerLink="/checkout" class="alert-link">try again</a>.
              </div>
            }
          }
          <div class="card shadow-sm mt-3">
            <div class="card-body">
              <div class="d-flex flex-wrap justify-content-between gap-2 mb-3">
                <div>
                  <h1 class="h4 mb-0">Order #{{ o.id.slice(0, 8) }}</h1>
                  <div class="small text-muted">{{ o.createdAt | date: 'medium' }}</div>
                </div>
                <div class="text-end">
                  <app-order-status-badge [status]="o.status" />
                  @if (o.payment; as pay) {
                    <div class="small text-muted mt-1">Payment: {{ pay.status }}</div>
                  }
                </div>
              </div>
              <div class="table-responsive">
                <table class="table align-middle mb-0">
                  <thead><tr><th>Item</th><th class="text-end">Price</th><th class="text-end">Qty</th><th class="text-end">Total</th></tr></thead>
                  <tbody>
                    @for (i of o.items; track i.productId) {
                      <tr>
                        <td><a [routerLink]="['/products', i.productId]" class="text-reset">{{ i.name }}</a></td>
                        <td class="text-end">{{ i.unitPriceCents | money }}</td>
                        <td class="text-end">{{ i.quantity }}</td>
                        <td class="text-end">{{ i.lineTotalCents | money }}</td>
                      </tr>
                    }
                  </tbody>
                  <tfoot><tr class="fw-semibold"><td colspan="3" class="text-end">Total</td><td class="text-end">{{ o.totalCents | money }}</td></tr></tfoot>
                </table>
              </div>
            </div>
          </div>
        }
      }
    }
  `,
})
export class OrderDetailPage {
  private readonly orders = inject(OrdersService);

  readonly id = input.required<string>(); // route param :id
  readonly placed = input<string | undefined>(); // query param ?placed=1

  protected readonly state = toSignal(
    toObservable(this.id).pipe(
      switchMap((id) =>
        this.orders.get(id).pipe(
          map((order): State => ({ status: 'ok', order })),
          catchError((e) => of<State>({ status: 'error', message: errorMessage(e) })),
          startWith<State>({ status: 'loading' }),
        ),
      ),
    ),
    { initialValue: { status: 'loading' } as State },
  );
  protected readonly order = computed(() => {
    const s = this.state();
    return s.status === 'ok' ? s.order : null;
  });
  protected readonly errorText = computed(() => {
    const s = this.state();
    return s.status === 'error' ? s.message : '';
  });
}
