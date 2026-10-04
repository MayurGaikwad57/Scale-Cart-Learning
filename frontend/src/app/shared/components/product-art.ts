import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { productArt } from '../product-art';

// Size is controlled by the parent through the CSS variable --art-size (emoji size) and the box it sits in.
@Component({
  selector: 'app-product-art',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'sc-art', '[style.background]': 'art().background', role: 'img', '[attr.aria-label]': 'category()' },
  template: `<span class="sc-art-emoji">{{ art().emoji }}</span>`,
})
export class ProductArt {
  readonly sku = input.required<string>();
  readonly category = input.required<string>();
  protected readonly art = computed(() => productArt(this.sku(), this.category()));
}
