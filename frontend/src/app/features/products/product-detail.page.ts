import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { catchError, map, of, startWith, switchMap } from 'rxjs';
import { errorMessage } from '../../core/http-error';
import { Product } from '../../core/models';
import { CartActionsService } from '../../core/services/cart-actions.service';
import { ProductsService } from '../../core/services/products.service';
import { Icon } from '../../shared/components/icon';
import { ProductArt } from '../../shared/components/product-art';
import { MoneyPipe } from '../../shared/pipes/money.pipe';

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; product: Product };

@Component({
  selector: 'app-product-detail-page',
  imports: [RouterLink, MoneyPipe, Icon, ProductArt],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (state().status) {
      @case ('loading') {
        <div class="row g-5">
          <div class="col-md-6"><div class="sc-skel" style="aspect-ratio: 1; border-radius: 28px"></div></div>
          <div class="col-md-6">
            <div class="sc-skel mb-3" style="height: 16px; width: 30%"></div>
            <div class="sc-skel mb-3" style="height: 40px; width: 80%"></div>
            <div class="sc-skel mb-4" style="height: 36px; width: 35%"></div>
            <div class="sc-skel mb-2" style="height: 14px"></div><div class="sc-skel" style="height: 14px; width: 85%"></div>
          </div>
        </div>
      }
      @case ('error') {
        <div class="sc-card sc-empty">
          <div class="sc-empty-icon"><app-icon name="alert" [size]="30" /></div>
          <h2 class="h5">We couldn't load this product</h2>
          <p class="sc-muted">{{ errorText() }}</p>
          <a routerLink="/products" class="sc-btn sc-btn-primary">Back to shop</a>
        </div>
      }
      @default {
        @if (product(); as p) {
          <nav class="sc-crumbs mb-4" aria-label="Breadcrumb">
            <a routerLink="/products">Shop</a><app-icon name="chevronRight" [size]="14" />
            <a routerLink="/products" [queryParams]="{ category: p.category }">{{ p.category }}</a><app-icon name="chevronRight" [size]="14" />
            <span class="text-truncate" style="color: var(--sc-ink)">{{ p.name }}</span>
          </nav>

          <div class="row g-4 g-lg-5">
            <div class="col-md-6"><app-product-art class="sc-detail-art" [sku]="p.sku" [category]="p.category" /></div>
            <div class="col-md-6 d-flex flex-column">
              <div class="d-flex gap-2 mb-3">
                <span class="sc-pill sc-pill-primary no-dot">{{ p.category }}</span>
                @if (!p.active) { <span class="sc-pill sc-pill-neutral">Inactive</span> }
              </div>
              <h1 class="fw-bold mb-2" style="font-size: clamp(1.8rem, 3vw, 2.5rem)">{{ p.name }}</h1>
              <div class="sc-muted small mb-3">SKU {{ p.sku }}</div>
              <div class="mb-3" style="font-size: 2.2rem; font-weight: 800; letter-spacing: -0.03em">{{ p.priceCents | money }}</div>

              <div class="sc-stockline mb-3" [style.color]="p.stock === 0 ? 'var(--sc-danger)' : p.stock <= 5 ? 'var(--sc-warn)' : 'var(--sc-success)'">
                <span class="sc-dot"></span>
                {{ p.stock === 0 ? 'Out of stock' : p.stock <= 5 ? 'Only ' + p.stock + ' left, order soon' : 'In stock (' + p.stock + ' available)' }}
              </div>

              <p class="sc-muted mb-4" style="line-height: 1.7">{{ p.description || 'No description yet.' }}</p>

              @if (p.stock > 0) {
                <div class="d-flex flex-wrap gap-3 align-items-center mb-4">
                  <div class="sc-qty" role="group" aria-label="Quantity">
                    <button type="button" aria-label="Decrease quantity" [disabled]="quantity() <= 1" (click)="setQuantity(quantity() - 1)"><app-icon name="minus" [size]="16" /></button>
                    <input type="number" min="1" [max]="maxQty()" [value]="quantity()" aria-label="Quantity" (change)="setQuantity($any($event.target).valueAsNumber)" />
                    <button type="button" aria-label="Increase quantity" [disabled]="quantity() >= maxQty()" (click)="setQuantity(quantity() + 1)"><app-icon name="plus" [size]="16" /></button>
                  </div>
                  <button class="sc-btn sc-btn-primary sc-btn-lg flex-grow-1" style="max-width: 320px" type="button" [disabled]="actions.busyId() === p.id" (click)="actions.add(p, quantity())">
                    @if (actions.busyId() === p.id) { <span class="sc-spinner"></span> Adding… } @else { <app-icon name="cart" [size]="19" /> Add to cart }
                  </button>
                </div>
              }

              <div class="sc-card sc-card-pad mt-auto">
                <div class="sc-perk mb-3"><span class="sc-perk-icon" style="width: 38px; height: 38px"><app-icon name="shield" [size]="19" /></span>
                  <div class="small"><b>Stock held at checkout</b><div class="sc-muted">We lock availability while your order is processed.</div></div></div>
                <div class="sc-perk"><span class="sc-perk-icon" style="width: 38px; height: 38px"><app-icon name="lock" [size]="19" /></span>
                  <div class="small"><b>Test-mode payments</b><div class="sc-muted">Nothing real is charged on this demo store.</div></div></div>
              </div>
            </div>
          </div>
        }
      }
    }
  `,
})
export class ProductDetailPage {
  private readonly products = inject(ProductsService);
  protected readonly actions = inject(CartActionsService);

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
  protected readonly maxQty = computed(() => Math.min(this.product()?.stock ?? 1, 99));

  protected readonly quantity = signal(1);

  protected setQuantity(value: number): void {
    this.quantity.set(Number.isFinite(value) ? Math.min(Math.max(1, Math.floor(value)), this.maxQty()) : 1);
  }
}
