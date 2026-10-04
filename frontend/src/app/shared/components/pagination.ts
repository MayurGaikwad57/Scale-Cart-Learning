import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

// Signal-based input()/output(): the parent passes numbers in and receives the chosen page back.
@Component({
  selector: 'app-pagination',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (pages() > 1) {
      <nav aria-label="Pagination">
        <ul class="pagination justify-content-center mb-0">
          <li class="page-item" [class.disabled]="page() <= 1">
            <button class="page-link" (click)="pageChange.emit(page() - 1)" [disabled]="page() <= 1">Previous</button>
          </li>
          <li class="page-item disabled"><span class="page-link">Page {{ page() }} of {{ pages() }}</span></li>
          <li class="page-item" [class.disabled]="page() >= pages()">
            <button class="page-link" (click)="pageChange.emit(page() + 1)" [disabled]="page() >= pages()">Next</button>
          </li>
        </ul>
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
