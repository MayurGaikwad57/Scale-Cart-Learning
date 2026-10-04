import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { catchError, map, of, startWith, switchMap } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { errorMessage } from '../../core/http-error';
import { Product } from '../../core/models';
import { CartService } from '../../core/services/cart.service';
import { ProductsService } from '../../core/services/products.service';
import { ToastService } from '../../core/services/toast.service';
import { categoryIcon } from '../../shared/category-icon';
import { MoneyPipe } from '../../shared/pipes/money.pipe';

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; product: Product };

@Component({
  selector: 'app-product-detail-page',
  imports: [RouterLink, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a routerLink="/products" class="small">&larr; Back to products</a>

    @switch (state().status) {
      @case ('loading') {
        <div class="text-center py-5"><div class="spinner-border" role="status"></div></div>
      }
      @case ('error') {
        <div class="alert alert-danger mt-3" role="alert">{{ errorText() }}</div>
      }
      @default {
        @if (product(); as p) {
          <div class="row g-4 mt-1">
            <div class="col-md-5"><div class="detail-tile">{{ icon() }}</div></div>
            <div class="col-md-7">
              <span class="badge text-bg-light mb-2">{{ p.category }}</span>
              <h1 class="h3">{{ p.name }}</h1>
              <div class="text-muted small mb-3">SKU {{ p.sku }}</div>
              <div class="display-6 mb-2">{{ p.priceCents | money }}</div>
              <p class="mb-3">{{ p.description || 'No description.' }}</p>
              <div class="mb-3" [class]="p.stock === 0 ? 'text-danger' : p.stock <= 5 ? 'text-warning-emphasis' : 'text-success'">
                {{ p.stock === 0 ? 'Out of stock' : p.stock <= 5 ? 'Only ' + p.stock + ' left' : 'In stock (' + p.stock + ')' }}
              </div>
              @if (p.stock > 0) {
                <div class="d-flex gap-2 align-items-center">
                  <label class="visually-hidden" for="qty">Quantity</label>
                  <input id="qty" type="number" class="form-control w-auto" style="width: 90px !important" min="1" [max]="maxQty()"
                    [value]="quantity()" (input)="setQuantity($any($event.target).valueAsNumber)" />
                  <button class="btn btn-primary" [disabled]="adding()" (click)="addToCart(p)">
                    {{ adding() ? 'Adding…' : 'Add to cart' }}
                  </button>
                </div>
              }
            </div>
          </div>
        }
      }
    }
  `,
})
export class ProductDetailPage {
  private readonly products = inject(ProductsService);
  private readonly cart = inject(CartService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  /** Bound from the route parameter :id (router uses withComponentInputBinding). */
  readonly id = input.required<string>();

  protected readonly state = toSignal(
    toObservable(this.id).pipe(
      switchMap((id) =>
        this.products.get(id).pipe(
          map((product): State => ({ status: 'ok', product })),
          catchError((e) => of<State>({ status: 'error', message: errorMessage(e) })),
          startWith<State>({ status: 'loading' }),
        ),
      ),
    ),
    { initialValue: { status: 'loading' } as State },
  );
  protected readonly product = computed(() => {
    const s = this.state();
    return s.status === 'ok' ? s.product : null;
  });
  protected readonly errorText = computed(() => {
    const s = this.state();
    return s.status === 'error' ? s.message : '';
  });
  protected readonly icon = computed(() => categoryIcon(this.product()?.category ?? ''));
  protected readonly maxQty = computed(() => Math.min(this.product()?.stock ?? 1, 99));

  protected readonly quantity = signal(1);
  protected readonly adding = signal(false);

  protected setQuantity(value: number): void {
    this.quantity.set(Number.isFinite(value) ? Math.min(Math.max(1, Math.floor(value)), this.maxQty()) : 1);
  }

  protected addToCart(product: Product): void {
    if (!this.auth.isLoggedIn()) {
      void this.router.navigate(['/login'], { queryParams: { returnUrl: this.router.url } });
      return;
    }
    this.adding.set(true);
    this.cart.add(product.id, this.quantity()).subscribe({
      next: () => {
        this.toast.show(`Added ${this.quantity()} × "${product.name}" to your cart`);
        this.adding.set(false);
      },
      error: (e) => {
        this.toast.show(errorMessage(e), 'danger', 4000);
        this.adding.set(false);
      },
    });
  }
}
