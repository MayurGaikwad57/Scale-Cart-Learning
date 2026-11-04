import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { catchError, EMPTY, expand, map, of, startWith, switchMap, take, timer } from 'rxjs';
import { errorMessage } from '../../core/http-error';
import { Order } from '../../core/models';
import { OrdersService } from '../../core/services/orders.service';
import { Icon, IconName } from '../../shared/components/icon';
import { OrderStatusBadge } from '../../shared/components/order-status-badge';
import { ProductArt } from '../../shared/components/product-art';
import { MoneyPipe } from '../../shared/pipes/money.pipe';

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; order: Order };
interface Step { label: string; state: 'done' | 'fail' | 'todo'; icon: IconName }

// Why a cancelled order was cancelled (statusReason from the order service).
const CANCEL_REASON: Record<string, string> = {
  payment_declined: 'The payment was declined.',
  payment_failed: 'The payment could not be processed. Nothing was charged.',
  inventory_unavailable: 'Our stock system was unavailable, so the order could not be completed. Nothing was charged.',
  out_of_stock: 'An item sold out before it could be reserved for you. Nothing was charged.',
  reservation_released: 'The reserved stock was released before payment completed. Nothing was charged.',
};
const POLL_MS = 1000;
const MAX_POLLS = 120; // stop asking after ~2 minutes (the page can be refreshed)

// Doubles as the "Order confirmation" page: checkout redirects here with ?placed=1.
// M6: payment is ASYNCHRONOUS (a separate payment service, via events), so a new order arrives
// here as PENDING. The page asks again every second until it is CONFIRMED or CANCELLED.
@Component({
  selector: 'app-order-detail-page',
  imports: [RouterLink, DatePipe, MoneyPipe, OrderStatusBadge, Icon, ProductArt],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a routerLink="/orders" class="sc-btn sc-btn-ghost sc-btn-sm mb-3"><app-icon name="arrowLeft" [size]="16" /> All orders</a>

    @switch (state().status) {
      @case ('loading') {
        <div class="sc-card sc-card-pad"><div class="sc-skel mb-3" style="height: 28px; width: 35%"></div><div class="sc-skel mb-4" style="height: 60px"></div>
          <div class="sc-skel mb-2" style="height: 48px"></div><div class="sc-skel" style="height: 48px"></div></div>
      }
      @case ('error') {
        <div class="sc-card sc-empty">
          <div class="sc-empty-icon"><app-icon name="alert" [size]="30" /></div>
          <h2 class="h5">We couldn't load this order</h2>
          <p class="sc-muted">{{ errorText() }}</p>
          <a routerLink="/orders" class="sc-btn sc-btn-primary">Back to my orders</a>
        </div>
      }
      @default {
        @if (order(); as o) {
          @if (placed()) {
            @if (o.status === 'PENDING') {
              <div class="sc-card sc-celebrate mb-4" style="background: linear-gradient(180deg, var(--sc-warn-50, #fffbeb), #fff)" data-testid="order-processing">
                <div class="sc-celebrate-icon sc-spin-slow" style="background: linear-gradient(135deg, #f59e0b, #d97706)"><app-icon name="refresh" [size]="38" /></div>
                <h2 class="fw-bold">Order placed - processing your payment…</h2>
                <p class="sc-muted mb-0">Your items are reserved. The payment service is charging your card; this page updates by itself.</p>
              </div>
            } @else if (o.status === 'CONFIRMED') {
              <div class="sc-card sc-celebrate mb-4" style="background: linear-gradient(180deg, var(--sc-success-50), #fff)">
                <div class="sc-celebrate-icon" style="background: linear-gradient(135deg, #10b981, #059669)"><app-icon name="check" [size]="38" /></div>
                <h2 class="fw-bold">Thank you! Your order is confirmed</h2>
                <p class="sc-muted mb-0">Payment succeeded and your items are reserved for you.</p>
              </div>
            } @else {
              <div class="sc-card sc-celebrate mb-4" style="background: linear-gradient(180deg, var(--sc-danger-50), #fff)">
                <div class="sc-celebrate-icon" style="background: linear-gradient(135deg, #f43f5e, #be123c)"><app-icon name="x" [size]="38" /></div>
                <h2 class="fw-bold">{{ o.statusReason === 'payment_declined' ? 'Payment was declined' : 'Order cancelled' }}</h2>
                <p class="sc-muted mb-3">{{ o.statusReason === 'payment_declined' ? '' : reasonText() }} The order was cancelled, any reserved stock was released, and your items are back in your cart.</p>
                <a routerLink="/checkout" class="sc-btn sc-btn-primary">Try again <app-icon name="arrowRight" [size]="18" /></a>
              </div>
            }
          }

          <div class="row g-4">
            <div class="col-lg-8">
              <div class="sc-card sc-card-pad mb-4">
                <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-4">
                  <div>
                    <h1 class="h4 mb-1">Order #{{ o.id.slice(0, 8) }}</h1>
                    <div class="sc-muted small">Placed {{ o.createdAt | date: 'd MMM y, h:mm a' }}</div>
                  </div>
                  <app-order-status-badge [status]="o.status" />
                </div>
                @if (o.status === 'CANCELLED' && reasonText() && !placed()) {
                  <div class="sc-alert sc-alert-danger mb-3 small"><app-icon name="alert" [size]="18" /><span>{{ reasonText() }}</span></div>
                }
                <ol class="sc-timeline" aria-label="Order progress">
                  @for (s of steps(); track s.label) {
                    <li class="sc-tl-step" [class.done]="s.state === 'done'" [class.fail]="s.state === 'fail'">
                      <span class="sc-tl-dot"><app-icon [name]="s.icon" [size]="16" /></span>{{ s.label }}
                    </li>
                  }
                </ol>
              </div>

              <div class="sc-card overflow-hidden">
                <div class="px-4 pt-3 pb-2 fw-bold">Items</div>
                @for (i of o.items; track i.productId) {
                  <div class="sc-line-item">
                    <app-product-art class="sc-thumb" [sku]="i.sku" [category]="i.category" />
                    <div class="flex-grow-1" style="min-width: 150px">
                      <a [routerLink]="['/products', i.productId]" class="fw-semibold text-reset">{{ i.name }}</a>
                      <div class="sc-muted small">{{ i.unitPriceCents | money }} × {{ i.quantity }}</div>
                    </div>
                    <div class="fw-bold">{{ i.lineTotalCents | money }}</div>
                  </div>
                }
              </div>
            </div>

            <div class="col-lg-4">
              <div class="sc-card sc-card-pad sc-summary">
                <h2 class="h5 mb-3">Summary</h2>
                <div class="sc-summary-row"><span>Items</span><span>{{ itemCount() }}</span></div>
                @if (o.payment; as pay) {
                  <div class="sc-summary-row"><span>Payment</span>
                    <span class="sc-pill" [class]="pay.status === 'SUCCEEDED' ? 'sc-pill-success' : pay.status === 'FAILED' ? 'sc-pill-danger' : 'sc-pill-warn'">{{ pay.status === 'SUCCEEDED' ? 'Paid' : pay.status === 'FAILED' ? 'Declined' : 'Pending' }}</span>
                  </div>
                }
                <div class="sc-total"><span>Total</span><span>{{ o.totalCents | money }}</span></div>
              </div>
            </div>
          </div>
        }
      }
    }
  `,
  styles: `
    .sc-spin-slow app-icon { display: inline-flex; animation: sc-spin 1.4s linear infinite; }
    @keyframes sc-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .sc-spin-slow app-icon { animation: none; } }
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
          // While PENDING: ask again in a second (expand = "for every answer, maybe make another request").
          expand((o) => (o.status === 'PENDING' ? timer(POLL_MS).pipe(switchMap(() => this.orders.get(id))) : EMPTY)),
          take(MAX_POLLS),
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
  protected readonly reasonText = computed(() => CANCEL_REASON[this.order()?.statusReason ?? ''] ?? '');
  protected readonly itemCount = computed(() => this.order()?.items.reduce((n, i) => n + i.quantity, 0) ?? 0);

  // Timeline derived from the order: placed -> payment -> final outcome.
  protected readonly steps = computed<Step[]>(() => {
    const o = this.order();
    if (!o) return [];
    const pay = o.payment?.status;
    const stockFailed = o.status === 'CANCELLED' && o.statusReason !== null && o.statusReason !== 'payment_declined';
    return [
      { label: 'Order placed', state: 'done', icon: 'package' },
      { label: stockFailed ? 'Stock not reserved' : 'Stock reserved', state: stockFailed ? 'fail' : 'done', icon: stockFailed ? 'x' : 'layers' },
      {
        label: pay === 'FAILED' ? 'Payment declined' : pay === 'PENDING' && o.status === 'PENDING' ? 'Payment processing…' : 'Payment',
        state: pay === 'SUCCEEDED' ? 'done' : pay === 'FAILED' ? 'fail' : 'todo',
        icon: pay === 'FAILED' ? 'x' : 'card',
      },
      { label: o.status === 'CANCELLED' ? 'Cancelled' : 'Confirmed', state: o.status === 'CONFIRMED' ? 'done' : o.status === 'CANCELLED' ? 'fail' : 'todo', icon: o.status === 'CANCELLED' ? 'x' : 'check' },
    ];
  });
}
