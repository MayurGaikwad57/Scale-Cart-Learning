import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Product } from '../../core/models';
import { MoneyPipe } from '../pipes/money.pipe';
import { Icon } from './icon';
import { ProductArt } from './product-art';

@Component({
  selector: 'app-product-card',
  imports: [RouterLink, MoneyPipe, Icon, ProductArt],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="sc-card sc-product">
      <a class="sc-product-media" [routerLink]="['/products', product().id]" [attr.aria-label]="'View ' + product().name" tabindex="-1">
        <app-product-art [sku]="product().sku" [category]="product().category" />
        @if (flag(); as f) {
          <span class="sc-pill sc-product-flag sc-pill-{{ f.kind }}">{{ f.text }}</span>
        }
      </a>
      <div class="sc-product-body">
        <span class="sc-product-cat">{{ product().category }}</span>
        <h3 class="sc-product-name"><a [routerLink]="['/products', product().id]">{{ product().name }}</a></h3>
        <div class="sc-product-foot">
          <span class="sc-price">{{ product().priceCents | money }}</span>
          <button class="sc-add" type="button" [disabled]="product().stock === 0 || busy()" (click)="add.emit(product())"
            [attr.aria-label]="product().stock === 0 ? product().name + ' is out of stock' : 'Add ' + product().name + ' to cart'">
            @if (busy()) { <span class="sc-spinner"></span> } @else { <app-icon name="plus" [size]="20" /> }
          </button>
        </div>
      </div>
    </article>
  `,
})
export class ProductCard {
  readonly product = input.required<Product>();
  readonly busy = input(false);
  readonly add = output<Product>();

  // Only call out the interesting states; plenty of stock needs no label.
  protected readonly flag = computed<{ text: string; kind: 'danger' | 'warn' } | null>(() => {
    const s = this.product().stock;
    if (s === 0) return { text: 'Sold out', kind: 'danger' };
    if (s <= 5) return { text: `Only ${s} left`, kind: 'warn' };
    return null;
  });
}
