import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Product } from '../../core/models';
import { MoneyPipe } from '../pipes/money.pipe';
import { categoryIcon } from '../category-icon';

@Component({
  selector: 'app-product-card',
  imports: [RouterLink, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card h-100 shadow-sm product-card">
      <a [routerLink]="['/products', product().id]" class="product-tile text-decoration-none" aria-hidden="true">{{ icon() }}</a>
      <div class="card-body d-flex flex-column">
        <span class="badge text-bg-light align-self-start mb-2">{{ product().category }}</span>
        <h6 class="card-title">
          <a [routerLink]="['/products', product().id]" class="text-reset text-decoration-none stretched-name">{{ product().name }}</a>
        </h6>
        <div class="mt-auto">
          <div class="fs-5 fw-semibold">{{ product().priceCents | money }}</div>
          <div class="small mb-2" [class]="stockClass()">{{ stockText() }}</div>
          <button class="btn btn-primary w-100" [disabled]="product().stock === 0 || busy()" (click)="add.emit(product())">
            {{ product().stock === 0 ? 'Out of stock' : 'Add to cart' }}
          </button>
        </div>
      </div>
    </div>
  `,
})
export class ProductCard {
  readonly product = input.required<Product>();
  readonly busy = input(false);
  readonly add = output<Product>();

  protected readonly icon = computed(() => categoryIcon(this.product().category));
  protected readonly stockText = computed(() => {
    const s = this.product().stock;
    return s === 0 ? 'Out of stock' : s <= 5 ? `Only ${s} left` : 'In stock';
  });
  protected readonly stockClass = computed(() => {
    const s = this.product().stock;
    return s === 0 ? 'text-danger' : s <= 5 ? 'text-warning-emphasis' : 'text-success';
  });
}
