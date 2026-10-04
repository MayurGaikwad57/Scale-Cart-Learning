import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { catchError, debounceTime, map, of, startWith, switchMap, tap } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { errorMessage } from '../../core/http-error';
import { Page, Product, ProductQuery, ProductSort } from '../../core/models';
import { CartService } from '../../core/services/cart.service';
import { ProductsService } from '../../core/services/products.service';
import { ToastService } from '../../core/services/toast.service';
import { Pagination } from '../../shared/components/pagination';
import { ProductCard } from '../../shared/components/product-card';

const PAGE_SIZE = 12;
const toCents = (rupees: number | null): number | undefined => (rupees === null ? undefined : Math.round(rupees * 100));

@Component({
  selector: 'app-product-list-page',
  imports: [ReactiveFormsModule, ProductCard, Pagination],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="h3 mb-3">Products</h1>

    <form [formGroup]="form" class="card card-body shadow-sm mb-4" (submit)="$event.preventDefault()">
      <div class="row g-2 align-items-end">
        <div class="col-12 col-lg-4">
          <label class="form-label small mb-1" for="q">Search</label>
          <input id="q" class="form-control" formControlName="q" placeholder="Name, description or SKU" />
        </div>
        <div class="col-6 col-lg-2">
          <label class="form-label small mb-1" for="category">Category</label>
          <select id="category" class="form-select" formControlName="category">
            <option value="">All</option>
            @for (c of categories(); track c) {
              <option [value]="c">{{ c }}</option>
            }
          </select>
        </div>
        <div class="col-3 col-lg-1">
          <label class="form-label small mb-1" for="min">Min ₹</label>
          <input id="min" type="number" min="0" class="form-control" formControlName="minPrice" />
        </div>
        <div class="col-3 col-lg-1">
          <label class="form-label small mb-1" for="max">Max ₹</label>
          <input id="max" type="number" min="0" class="form-control" formControlName="maxPrice" />
        </div>
        <div class="col-8 col-lg-3">
          <label class="form-label small mb-1" for="sort">Sort by</label>
          <select id="sort" class="form-select" formControlName="sort">
            <option value="newest">Newest</option>
            <option value="price_asc">Price: low to high</option>
            <option value="price_desc">Price: high to low</option>
            <option value="name">Name</option>
          </select>
        </div>
        <div class="col-4 col-lg-1 d-grid">
          <button type="button" class="btn btn-outline-secondary" (click)="reset()">Reset</button>
        </div>
      </div>
    </form>

    @if (error()) {
      <div class="alert alert-danger" role="alert">{{ error() }}</div>
    }

    @if (loading() && !result()) {
      <div class="text-center py-5"><div class="spinner-border" role="status"><span class="visually-hidden">Loading</span></div></div>
    } @else if (result(); as r) {
      <div class="d-flex justify-content-between small text-muted mb-2">
        <span>{{ r.total }} product{{ r.total === 1 ? '' : 's' }}</span>
        @if (loading()) { <span>Updating…</span> }
      </div>
      @if (r.items.length === 0) {
        <div class="text-center text-muted py-5">No products match your filters.</div>
      } @else {
        <div class="row row-cols-1 row-cols-sm-2 row-cols-lg-4 g-3 mb-4">
          @for (p of r.items; track p.id) {
            <div class="col"><app-product-card [product]="p" [busy]="addingId() === p.id" (add)="addToCart($event)" /></div>
          }
        </div>
        <app-pagination [page]="page()" [pageSize]="pageSize" [total]="r.total" (pageChange)="goToPage($event)" />
      }
    }
  `,
})
export class ProductListPage {
  private readonly products = inject(ProductsService);
  private readonly cart = inject(CartService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  protected readonly pageSize = PAGE_SIZE;

  // Filters live in a reactive form (user input). The page number is separate local state.
  protected readonly form = inject(NonNullableFormBuilder).group({
    q: [''],
    category: [''],
    minPrice: new FormControl<number | null>(null),
    maxPrice: new FormControl<number | null>(null),
    sort: ['newest' as ProductSort],
  });
  protected readonly page = signal(1);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly addingId = signal<string | null>(null);

  protected readonly categories = toSignal(this.products.categories().pipe(catchError(() => of([] as string[]))), { initialValue: [] });

  // The form's current value as a signal, so the query below can be a computed().
  private readonly filters = toSignal(
    this.form.valueChanges.pipe(
      map(() => this.form.getRawValue()),
      startWith(this.form.getRawValue()),
    ),
    { requireSync: true },
  );

  // Everything the server needs, derived from filters + page. Changes whenever either changes.
  private readonly query = computed<ProductQuery>(() => {
    const f = this.filters();
    return {
      page: this.page(),
      pageSize: PAGE_SIZE,
      q: f.q.trim() || undefined,
      category: f.category || undefined,
      minPrice: toCents(f.minPrice),
      maxPrice: toCents(f.maxPrice),
      sort: f.sort,
    };
  });

  // RxJS does what it is best at here: wait while the user types (debounceTime) and cancel the
  // previous in-flight request when a newer query arrives (switchMap), so stale results never overwrite fresh ones.
  protected readonly result = toSignal<Page<Product> | null>(
    toObservable(this.query).pipe(
      debounceTime(300),
      tap(() => {
        this.loading.set(true);
        this.error.set(null);
      }),
      switchMap((q) =>
        this.products.list(q).pipe(
          catchError((e) => {
            this.error.set(errorMessage(e));
            return of(null);
          }),
        ),
      ),
      tap(() => this.loading.set(false)),
    ),
    { initialValue: null },
  );

  constructor() {
    // A changed filter means "start from page 1" (otherwise you could land on a page that no longer exists).
    this.form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => this.page.set(1));
  }

  protected goToPage(p: number): void {
    this.page.set(p);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  protected reset(): void {
    this.form.reset({ q: '', category: '', minPrice: null, maxPrice: null, sort: 'newest' });
  }

  protected addToCart(product: Product): void {
    if (!this.auth.isLoggedIn()) {
      void this.router.navigate(['/login'], { queryParams: { returnUrl: this.router.url } });
      return;
    }
    this.addingId.set(product.id);
    this.cart.add(product.id, 1).subscribe({
      next: () => {
        this.toast.show(`Added "${product.name}" to your cart`);
        this.addingId.set(null);
      },
      error: (e) => {
        this.toast.show(errorMessage(e), 'danger', 4000);
        this.addingId.set(null);
      },
    });
  }
}
