import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { Icon } from './icon';

// Signal-based input()/output(): the parent passes numbers in and receives the chosen page back.
@Component({
  selector: 'app-pagination',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (pages() > 1) {
      <nav class="sc-pager" aria-label="Pagination">
        <button class="sc-btn sc-btn-sm" type="button" [disabled]="page() <= 1" (click)="pageChange.emit(page() - 1)">
          <app-icon name="arrowLeft" [size]="16" /> Previous
        </button>
        <span class="sc-pager-info">Page {{ page() }} of {{ pages() }}</span>
        <button class="sc-btn sc-btn-sm" type="button" [disabled]="page() >= pages()" (click)="pageChange.emit(page() + 1)">
          Next <app-icon name="arrowRight" [size]="16" />
        </button>
      </nav>
    }
  `,
})
export class Pagination {
  readonly page = input.required<number>();
  readonly pageSize = input.required<number>();
  readonly total = input.required<number>();
  readonly pageChange = output<number>();

  protected readonly pages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));
}
