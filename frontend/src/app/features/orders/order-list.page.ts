import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { catchError, of, switchMap, tap } from 'rxjs';
import { errorMessage } from '../../core/http-error';
import { OrdersService } from '../../core/services/orders.service';
import { Icon } from '../../shared/components/icon';
import { OrderStatusBadge } from '../../shared/components/order-status-badge';
import { Pagination } from '../../shared/components/pagination';
import { ProductArt } from '../../shared/components/product-art';
import { MoneyPipe } from '../../shared/pipes/money.pipe';

const PAGE_SIZE = 10;

@Component({
  selector: 'app-order-list-page',
  imports: [RouterLink, DatePipe, MoneyPipe, OrderStatusBadge, Pagination, Icon, ProductArt],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-4">
      <div class="sc-eyebrow">Account</div>
      <h1 class="sc-page-title">My orders</h1>
    </div>

    @if (error()) {
      <div class="sc-alert sc-alert-danger mb-3" role="alert"><app-icon name="alert" [size]="20" /><span>{{ error() }}</span></div>
    }

    @if (result(); as r) {
      @if (r.items.length === 0) {
        <div class="sc-card sc-empty">
          <div class="sc-empty-icon"><app-icon name="package" [size]="32" /></div>
          <h2 class="h5">No orders yet</h2>
          <p class="sc-muted">When you place an order, it will show up here.</p>
          <a routerLink="/products" class="sc-btn sc-btn-primary">Start shopping <app-icon name="arrowRight" [size]="18" /></a>
        </div>
      } @else {
        <div class="sc-card overflow-hidden mb-4">
          @for (o of r.items; track o.id) {
            <a class="sc-order-row" [routerLink]="['/orders', o.id]">
              <div class="sc-thumbs">
                @for (i of o.items.slice(0, 3); track i.productId) {
                  <app-product-art class="sc-thumb-sm" [sku]="i.sku" [category]="i.category" />
                }
                @if (o.items.length > 3) { <span class="sc-thumb-more">+{{ o.items.length - 3 }}</span> }
              </div>
              <div class="flex-grow-1" style="min-width: 160px">
                <div class="fw-bold">Order #{{ o.id.slice(0, 8) }}</div>
                <div class="sc-muted small text-truncate" style="max-width: 420px">
                  {{ o.items[0].name }}@if (o.items.length > 1) { and {{ o.items.length - 1 }} more }
                </div>
                <div class="sc-muted small">{{ o.createdAt | date: 'd MMM y, h:mm a' }}</div>
              </div>
              <div class="text-end">
                <app-order-status-badge [status]="o.status" />
                <div class="fw-bold mt-1">{{ o.totalCents | money }}</div>
              </div>
              <app-icon name="chevronRight" [size]="18" />
            </a>
          }
        </div>
        <app-pagination [page]="page()" [pageSize]="pageSize" [total]="r.total" (pageChange)="page.set($event)" />
      }
    } @else if (!error()) {
      <div class="sc-card overflow-hidden">
        @for (n of [1, 2, 3]; track n) {
          <div class="sc-order-row"><div class="sc-skel" style="width: 44px; height: 44px"></div>
            <div class="flex-grow-1"><div class="sc-skel mb-2" style="height: 14px; width: 30%"></div><div class="sc-skel" style="height: 12px; width: 50%"></div></div>
            <div class="sc-skel" style="height: 22px; width: 90px"></div></div>
        }
      </div>
    }
  `,
})
export class OrderListPage {
  private readonly orders = inject(OrdersService);
  protected readonly pageSize = PAGE_SIZE;
  protected readonly page = signal(1);
  protected readonly error = signal<string | null>(null);

  protected readonly result = toSignal(
    toObservable(this.page).pipe(
      tap(() => this.error.set(null)),
      switchMap((p) =>
        this.orders.list(p, PAGE_SIZE).pipe(
          catchError((e) => {
            this.error.set(errorMessage(e));
            return of(null);
          }),
        ),
      ),
    ),
    { initialValue: null },
  );
}
