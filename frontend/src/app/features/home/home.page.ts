import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { Product } from '../../core/models';
import { CartActionsService } from '../../core/services/cart-actions.service';
import { ProductsService } from '../../core/services/products.service';
import { Icon } from '../../shared/components/icon';
import { ProductArt } from '../../shared/components/product-art';
import { ProductCard } from '../../shared/components/product-card';
import { MoneyPipe } from '../../shared/pipes/money.pipe';

@Component({
  selector: 'app-home-page',
  imports: [RouterLink, Icon, ProductArt, ProductCard, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="sc-hero">
      <div class="row align-items-center g-4">
        <div class="col-lg-7">
          <span class="sc-hero-chip"><app-icon name="zap" [size]="15" /> Real-time stock, safe checkout</span>
          <h1>Shop smarter.<br />Never pay for what's gone.</h1>
          <p>
            Browse the catalog, fill your cart and check out. Stock is locked for you while your order is processed, so two people can never buy the last item.
          </p>
          <div class="d-flex flex-wrap gap-2 mt-4">
            <a class="sc-btn sc-btn-white sc-btn-lg" routerLink="/products">Start shopping <app-icon name="arrowRight" [size]="18" /></a>
            @if (!auth.isLoggedIn()) {
              <a class="sc-btn sc-btn-lg" style="background: rgba(255,255,255,.16); color: #fff; border-color: rgba(255,255,255,.35)" routerLink="/register">Create account</a>
            }
          </div>
        </div>
        <div class="col-lg-5">
          <div class="sc-hero-stack" aria-hidden="true">
            @for (p of heroProducts(); track p.id; let i = $index) {
              <div class="sc-hero-card" [style.top.px]="[0, 70, 240][i]" [style.left.px]="[0, 190, 10][i]" [style.--r]="['-5deg', '4deg', '-2deg'][i]"
                [style.animation-delay.s]="i * 0.8">
                <app-product-art [sku]="p.sku" [category]="p.category" />
                <b>{{ p.name }}</b>
                <small>{{ p.priceCents | money }}</small>
              </div>
            }
          </div>
        </div>
      </div>
    </section>

    <section class="mt-5">
      <div class="row g-3">
        @for (perk of perks; track perk.title) {
          <div class="col-md-4">
            <div class="sc-perk">
              <span class="sc-perk-icon"><app-icon [name]="perk.icon" [size]="22" /></span>
              <div>
                <div class="fw-bold">{{ perk.title }}</div>
                <div class="sc-muted small">{{ perk.text }}</div>
              </div>
            </div>
          </div>
        }
      </div>
    </section>

    <div class="sc-section-head">
      <div>
        <div class="sc-eyebrow">Browse</div>
        <h2>Shop by category</h2>
      </div>
    </div>
    <div class="row g-3">
      @for (c of categories(); track c) {
        <div class="col-6 col-lg-3">
          <a class="sc-cat-tile" routerLink="/products" [queryParams]="{ category: c }">
            <app-product-art [sku]="'category-' + c" [category]="c" />
            <span>{{ c }}<small>Browse →</small></span>
          </a>
        </div>
      }
    </div>

    <div class="sc-section-head">
      <div>
        <div class="sc-eyebrow">Just in</div>
        <h2>New arrivals</h2>
      </div>
      <a class="sc-btn sc-btn-soft sc-btn-sm" routerLink="/products">View all <app-icon name="arrowRight" [size]="16" /></a>
    </div>
    <div class="row row-cols-2 row-cols-lg-4 g-3">
      @if (featured(); as items) {
        @for (p of items; track p.id) {
          <div class="col"><app-product-card [product]="p" [busy]="actions.busyId() === p.id" (add)="actions.add($event)" /></div>
        }
      } @else {
        @for (n of [1, 2, 3, 4]; track n) {
          <div class="col"><div class="sc-card"><div class="sc-skel" style="aspect-ratio: 4/3; border-radius: 16px 16px 0 0"></div>
            <div class="p-3"><div class="sc-skel mb-2" style="height: 12px; width: 40%"></div><div class="sc-skel mb-3" style="height: 16px"></div><div class="sc-skel" style="height: 22px; width: 50%"></div></div></div></div>
        }
      }
    </div>
  `,
})
export class HomePage {
  protected readonly auth = inject(AuthService);
  protected readonly actions = inject(CartActionsService);
  private readonly products = inject(ProductsService);

  protected readonly perks = [
    { icon: 'shield' as const, title: 'Stock you can trust', text: 'Availability is locked while you check out, so an order never fails after payment.' },
    { icon: 'card' as const, title: 'Safe test payments', text: 'Try a successful or a declined card. Nothing real is ever charged.' },
    { icon: 'package' as const, title: 'Every order tracked', text: 'See the status and full history of everything you have bought.' },
  ];

  protected readonly featured = toSignal(
    this.products.list({ page: 1, pageSize: 4, sort: 'newest' }).pipe(
      map((p) => p.items),
      catchError(() => of([] as Product[])),
    ),
    { initialValue: null },
  );
  protected readonly categories = toSignal(this.products.categories().pipe(catchError(() => of([] as string[]))), { initialValue: [] as string[] });

  protected heroProducts(): Product[] {
    return (this.featured() ?? []).slice(0, 3);
  }
}
