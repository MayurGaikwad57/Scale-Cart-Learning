import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { catchError, of, switchMap, tap } from 'rxjs';
import { errorMessage } from '../../core/http-error';
import { OrdersService } from '../../core/services/orders.service';
import { OrderStatusBadge } from '../../shared/components/order-status-badge';
import { Pagination } from '../../shared/components/pagination';
import { MoneyPipe } from '../../shared/pipes/money.pipe';

const PAGE_SIZE = 10;

@Component({
  selector: 'app-order-list-page',
  imports: [RouterLink, DatePipe, MoneyPipe, OrderStatusBadge, Pagination],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="h3 mb-3">My orders</h1>
    @if (error()) {
      <div class="alert alert-danger" role="alert">{{ error() }}</div>
    }
    @if (result(); as r) {
      @if (r.items.length === 0) {
        <div class="card card-body text-center py-5 shadow-sm">
          <p class="mb-3 text-muted">You have not placed any orders yet.</p>
          <div><a routerLink="/products" class="btn btn-primary">Start shopping</a></div>
        </div>
      } @else {
        <div class="list-group shadow-sm mb-3">
          @for (o of r.items; track o.id) {
            <a [routerLink]="['/orders', o.id]" class="list-group-item list-group-item-action">
              <div class="d-flex flex-wrap justify-content-between gap-2">
                <div>
                  <div class="fw-semibold">Order #{{ o.id.slice(0, 8) }}</div>
                  <div class="small text-muted">{{ o.createdAt | date: 'medium' }} · {{ o.items.length }} line{{ o.items.length === 1 ? '' : 's' }}</div>
                </div>
                <div class="text-end">
                  <app-order-status-badge [status]="o.status" />
                  <div class="fw-semibold">{{ o.totalCents | money }}</div>
                </div>
              </div>
            </a>
          }
        </div>
        <app-pagination [page]="page()" [pageSize]="pageSize" [total]="r.total" (pageChange)="page.set($event)" />
      }
    } @else if (!error()) {
      <div class="text-center py-5"><div class="spinner-border" role="status"></div></div>
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
