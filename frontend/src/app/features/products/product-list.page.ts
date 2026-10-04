import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { catchError, debounceTime, map, of, startWith, switchMap, tap } from 'rxjs';
import { errorMessage } from '../../core/http-error';
import { Page, Product, ProductQuery, ProductSort } from '../../core/models';
import { CartActionsService } from '../../core/services/cart-actions.service';
import { ProductsService } from '../../core/services/products.service';
import { Icon } from '../../shared/components/icon';
import { Pagination } from '../../shared/components/pagination';
import { ProductCard } from '../../shared/components/product-card';

const PAGE_SIZE = 12;
const toCents = (rupees: number | null): number | undefined => (rupees === null ? undefined : Math.round(rupees * 100));

@Component({
  selector: 'app-product-list-page',
  imports: [ReactiveFormsModule, ProductCard, Pagination, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="d-flex flex-wrap align-items-end justify-content-between gap-3 mb-4">
      <div>
        <div class="sc-eyebrow">Catalog</div>
        <h1 class="sc-page-title">Shop all products</h1>
      </div>
      <div class="d-flex gap-2 align-items-center">
        <button type="button" class="sc-btn d-lg-none" (click)="filtersOpen.set(!filtersOpen())" [attr.aria-expanded]="filtersOpen()">
          <app-icon name="sliders" [size]="18" /> Filters
          @if (activeCount() > 0) { <span class="sc-pill sc-pill-primary no-dot">{{ activeCount() }}</span> }
        </button>
        <label class="visually-hidden" for="sort">Sort by</label>
        <select id="sort" class="form-select" style="min-width: 190px" [formControl]="form.controls.sort">
          <option value="newest">Newest first</option>
          <option value="price_asc">Price: low to high</option>
          <option value="price_desc">Price: high to low</option>
          <option value="name">Name: A to Z</option>
        </select>
      </div>
    </div>

    <div class="sc-search mb-4">
      <app-icon name="search" [size]="20" />
      <label class="visually-hidden" for="q">Search products</label>
      <input id="q" class="form-control" [formControl]="form.controls.q" placeholder="Search by name, description or SKU…" autocomplete="off" />
    </div>

    <div class="row g-4">
      <aside class="col-lg-3" [class.d-none]="!filtersOpen()" [class.d-lg-block]="true">
        <div class="sc-card sc-card-pad sc-filters">
          <h2 class="sc-filter-title">Category</h2>
          <div class="sc-filter-list mb-4" role="group" aria-label="Category">
            <button type="button" class="sc-filter-opt" [class.on]="!form.controls.category.value" (click)="form.controls.category.setValue('')">All products</button>
            @for (c of categories(); track c) {
              <button type="button" class="sc-filter-opt" [class.on]="form.controls.category.value === c" (click)="form.controls.category.setValue(c)">{{ c }}</button>
            }
          </div>

          <h2 class="sc-filter-title">Price (₹)</h2>
          <div class="d-flex align-items-center gap-2 mb-4">
            <label class="visually-hidden" for="min">Minimum price</label>
            <input id="min" type="number" min="0" class="form-control" placeholder="Min" [formControl]="form.controls.minPrice" />
            <span class="sc-muted">–</span>
            <label class="visually-hidden" for="max">Maximum price</label>
            <input id="max" type="number" min="0" class="form-control" placeholder="Max" [formControl]="form.controls.maxPrice" />
          </div>

          <button type="button" class="sc-btn sc-btn-block" [disabled]="activeCount() === 0" (click)="reset()">Clear all filters</button>
        </div>
      </aside>

      <section class="col-lg-9" aria-live="polite">
        @if (error()) {
          <div class="sc-alert sc-alert-danger mb-3" role="alert"><app-icon name="alert" [size]="20" /><span>{{ error() }}</span></div>
        }

        @if (chips().length > 0) {
          <div class="d-flex flex-wrap gap-2 mb-3">
            @for (chip of chips(); track chip.key) {
              <span class="sc-chip">{{ chip.label }}<button type="button" [attr.aria-label]="'Remove filter ' + chip.label" (click)="clearChip(chip.key)"><app-icon name="x" [size]="12" /></button></span>
            }
          </div>
        }

        @if (loading() && !result()) {
          <div class="row row-cols-2 row-cols-md-3 g-3">
            @for (n of skeletons; track n) {
              <div class="col"><div class="sc-card"><div class="sc-skel" style="aspect-ratio: 4/3; border-radius: 16px 16px 0 0"></div>
                <div class="p-3"><div class="sc-skel mb-2" style="height: 12px; width: 40%"></div><div class="sc-skel mb-3" style="height: 16px"></div><div class="sc-skel" style="height: 22px; width: 50%"></div></div></div></div>
            }
          </div>
        } @else if (result(); as r) {
          <div class="d-flex justify-content-between small sc-muted fw-semibold mb-3">
            <span>{{ r.total }} product{{ r.total === 1 ? '' : 's' }}</span>
            @if (loading()) { <span>Updating…</span> }
          </div>
          @if (r.items.length === 0) {
            <div class="sc-card sc-empty">
              <div class="sc-empty-icon"><app-icon name="search" [size]="30" /></div>
              <h2 class="h5">No products match your filters</h2>
              <p class="sc-muted">Try a different search or clear the filters.</p>
              <button type="button" class="sc-btn sc-btn-primary" (click)="reset()">Clear all filters</button>
            </div>
          } @else {
            <div class="row row-cols-2 row-cols-md-3 g-3 mb-4" [style.opacity]="loading() ? 0.6 : 1" style="transition: opacity .15s">
              @for (p of r.items; track p.id) {
                <div class="col"><app-product-card [product]="p" [busy]="actions.busyId() === p.id" (add)="actions.add($event)" /></div>
              }
            </div>
            <app-pagination [page]="page()" [pageSize]="pageSize" [total]="r.total" (pageChange)="goToPage($event)" />
          }
        }
      </section>
    </div>
  `,
})
export class ProductListPage {
  private readonly products = inject(ProductsService);
  protected readonly actions = inject(CartActionsService);

  /** Optional query params (?category=Books&q=lamp), e.g. from the home page's category tiles. */
  readonly category = input<string | undefined>();
  readonly q = input<string | undefined>();

  protected readonly pageSize = PAGE_SIZE;
  protected readonly skeletons = Array.from({ length: 6 }, (_, i) => i);

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
  protected readonly filtersOpen = signal(false);

  protected readonly categories = toSignal(this.products.categories().pipe(catchError(() => of([] as string[]))), { initialValue: [] as string[] });

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

  /** The removable "chips" shown above the grid, derived from the current filters. */
  protected readonly chips = computed(() => {
    const f = this.filters();
    const chips: { key: 'q' | 'category' | 'price'; label: string }[] = [];
    if (f.q.trim()) chips.push({ key: 'q', label: `“${f.q.trim()}”` });
    if (f.category) chips.push({ key: 'category', label: f.category });
    if (f.minPrice !== null || f.maxPrice !== null) {
      chips.push({ key: 'price', label: `₹${f.minPrice ?? 0} – ${f.maxPrice !== null ? '₹' + f.maxPrice : 'any'}` });
    }
    return chips;
  });
  protected readonly activeCount = computed(() => this.chips().length);

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

    // Query params arrive as signal inputs; copy them into the form (also when only the URL changes).
    effect(() => {
      const category = this.category();
      const q = this.q();
      untracked(() => this.form.patchValue({ category: category ?? '', q: q ?? '' }));
    });
  }

  protected goToPage(p: number): void {
    this.page.set(p);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  protected clearChip(key: 'q' | 'category' | 'price'): void {
    if (key === 'q') this.form.controls.q.setValue('');
    else if (key === 'category') this.form.controls.category.setValue('');
    else this.form.patchValue({ minPrice: null, maxPrice: null });
  }

  protected reset(): void {
    this.form.reset({ q: '', category: '', minPrice: null, maxPrice: null, sort: 'newest' });
  }
}
