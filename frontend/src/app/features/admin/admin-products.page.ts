import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Observable, catchError, combineLatest, of, switchMap, tap } from 'rxjs';
import { Icon } from '../../shared/components/icon';
import { ProductArt } from '../../shared/components/product-art';
import { errorMessage } from '../../core/http-error';
import { Page, Product } from '../../core/models';
import { ProductsService } from '../../core/services/products.service';
import { ToastService } from '../../core/services/toast.service';
import { Pagination } from '../../shared/components/pagination';
import { MoneyPipe } from '../../shared/pipes/money.pipe';

const PAGE_SIZE = 20;

@Component({
  selector: 'app-admin-products-page',
  imports: [RouterLink, MoneyPipe, Pagination, Icon, ProductArt],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="d-flex flex-wrap justify-content-between align-items-end gap-3 mb-4">
      <div>
        <div class="sc-eyebrow">Admin</div>
        <h1 class="sc-page-title">Manage products</h1>
        <p class="sc-muted mb-0">Create products, change prices, set stock and show or hide items in the shop.</p>
      </div>
      <a routerLink="/admin/products/new" class="sc-btn sc-btn-primary"><app-icon name="plus" [size]="18" /> New product</a>
    </div>

    @if (error()) {
      <div class="sc-alert sc-alert-danger mb-3" role="alert"><app-icon name="alert" [size]="20" /><span>{{ error() }}</span></div>
    }

    @if (result(); as r) {
      <div class="sc-card overflow-hidden mb-3">
        <div class="table-responsive">
          <table class="sc-table">
            <thead>
              <tr><th>Product</th><th>Category</th><th class="text-end">Price</th><th>Stock</th><th>Status</th><th class="text-end">Actions</th></tr>
            </thead>
            <tbody>
              @for (p of r.items; track p.id) {
                <tr [style.opacity]="p.active ? 1 : 0.6">
                  <td>
                    <div class="d-flex align-items-center gap-3">
                      <app-product-art class="sc-thumb-sm" [sku]="p.sku" [category]="p.category" />
                      <div><div class="fw-semibold">{{ p.name }}</div><div class="sc-muted small">{{ p.sku }}</div></div>
                    </div>
                  </td>
                  <td>{{ p.category }}</td>
                  <td class="text-end fw-semibold">{{ p.priceCents | money }}</td>
                  <td>
                    <div class="sc-stock-input">
                      <input #stockInput type="number" min="0" class="form-control" [value]="p.stock" [attr.aria-label]="'Stock for ' + p.name" />
                      <button class="sc-btn sc-btn-soft sc-btn-sm" type="button" [disabled]="busyId() === p.id" (click)="saveStock(p, stockInput.valueAsNumber)">Save</button>
                    </div>
                  </td>
                  <td><span class="sc-pill" [class]="p.active ? 'sc-pill-success' : 'sc-pill-neutral'">{{ p.active ? 'Active' : 'Hidden' }}</span></td>
                  <td class="text-nowrap text-end">
                    <a [routerLink]="['/admin/products', p.id, 'edit']" class="sc-btn sc-btn-sm me-1"><app-icon name="edit" [size]="15" /> Edit</a>
                    <button class="sc-btn sc-btn-sm" [class]="p.active ? 'sc-btn-danger' : 'sc-btn-soft'" type="button" [disabled]="busyId() === p.id" (click)="toggleActive(p)">
                      {{ p.active ? 'Hide' : 'Show' }}
                    </button>
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="text-center sc-muted py-5">No products yet. Create the first one.</td></tr>
              }
            </tbody>
          </table>
        </div>
      </div>
      <app-pagination [page]="page()" [pageSize]="pageSize" [total]="r.total" (pageChange)="page.set($event)" />
    } @else if (!error()) {
      <div class="sc-card p-4">
        @for (n of [1, 2, 3, 4]; track n) { <div class="sc-skel mb-3" style="height: 44px"></div> }
      </div>
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
