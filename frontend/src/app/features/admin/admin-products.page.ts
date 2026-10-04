import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Observable, catchError, combineLatest, of, switchMap, tap } from 'rxjs';
import { errorMessage } from '../../core/http-error';
import { Page, Product } from '../../core/models';
import { ProductsService } from '../../core/services/products.service';
import { ToastService } from '../../core/services/toast.service';
import { Pagination } from '../../shared/components/pagination';
import { MoneyPipe } from '../../shared/pipes/money.pipe';

const PAGE_SIZE = 20;

@Component({
  selector: 'app-admin-products-page',
  imports: [RouterLink, MoneyPipe, Pagination],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h1 class="h3 mb-0">Manage products</h1>
      <a routerLink="/admin/products/new" class="btn btn-primary">+ New product</a>
    </div>

    @if (error()) {
      <div class="alert alert-danger" role="alert">{{ error() }}</div>
    }

    @if (result(); as r) {
      <div class="card shadow-sm mb-3">
        <div class="table-responsive">
          <table class="table table-hover align-middle mb-0">
            <thead class="table-light">
              <tr><th>SKU</th><th>Name</th><th>Category</th><th class="text-end">Price</th><th style="width: 190px">Stock</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              @for (p of r.items; track p.id) {
                <tr [class.text-muted]="!p.active">
                  <td class="small">{{ p.sku }}</td>
                  <td>{{ p.name }}</td>
                  <td>{{ p.category }}</td>
                  <td class="text-end">{{ p.priceCents | money }}</td>
                  <td>
                    <div class="input-group input-group-sm">
                      <input #stockInput type="number" min="0" class="form-control" [value]="p.stock" [attr.aria-label]="'Stock for ' + p.name" />
                      <button class="btn btn-outline-primary" [disabled]="busyId() === p.id" (click)="saveStock(p, stockInput.valueAsNumber)">Save</button>
                    </div>
                  </td>
                  <td><span class="badge" [class]="p.active ? 'text-bg-success' : 'text-bg-secondary'">{{ p.active ? 'Active' : 'Inactive' }}</span></td>
                  <td class="text-nowrap text-end">
                    <a [routerLink]="['/admin/products', p.id, 'edit']" class="btn btn-sm btn-outline-secondary me-1">Edit</a>
                    <button class="btn btn-sm" [class]="p.active ? 'btn-outline-danger' : 'btn-outline-success'" [disabled]="busyId() === p.id" (click)="toggleActive(p)">
                      {{ p.active ? 'Deactivate' : 'Activate' }}
                    </button>
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="7" class="text-center text-muted py-4">No products yet.</td></tr>
              }
            </tbody>
          </table>
        </div>
      </div>
      <app-pagination [page]="page()" [pageSize]="pageSize" [total]="r.total" (pageChange)="page.set($event)" />
    } @else if (!error()) {
      <div class="text-center py-5"><div class="spinner-border" role="status"></div></div>
    }
  `,
})
export class AdminProductsPage {
  private readonly products = inject(ProductsService);
  private readonly toast = inject(ToastService);

  protected readonly pageSize = PAGE_SIZE;
  protected readonly page = signal(1);
  private readonly reloadTick = signal(0); // bump to refetch after a change
  protected readonly busyId = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  protected readonly result = toSignal<Page<Product> | null>(
    combineLatest([toObservable(this.page), toObservable(this.reloadTick)]).pipe(
      tap(() => this.error.set(null)),
      switchMap(([page]) =>
        this.products.list({ page, pageSize: PAGE_SIZE, sort: 'newest', includeInactive: true }).pipe(
          catchError((e) => {
            this.error.set(errorMessage(e));
            return of(null);
          }),
        ),
      ),
    ),
    { initialValue: null },
  );

  protected saveStock(p: Product, value: number): void {
    if (!Number.isInteger(value) || value < 0) {
      this.toast.show('Stock must be a whole number, 0 or more', 'danger');
      return;
    }
    this.run(p, this.products.setStock(p.id, value), `Stock of "${p.name}" set to ${value}`);
  }

  protected toggleActive(p: Product): void {
    this.run(p, this.products.update(p.id, { active: !p.active }), `"${p.name}" is now ${p.active ? 'inactive' : 'active'}`);
  }

  private run(p: Product, request: Observable<unknown>, success: string): void {
    this.busyId.set(p.id);
    request.subscribe({
      next: () => {
        this.toast.show(success);
        this.busyId.set(null);
        this.reloadTick.update((n) => n + 1);
      },
      error: (e) => {
        this.toast.show(errorMessage(e), 'danger', 4000);
        this.busyId.set(null);
      },
    });
  }
}
