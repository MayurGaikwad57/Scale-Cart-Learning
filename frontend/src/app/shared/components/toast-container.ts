import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-toast-container',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toast-stack">
      @for (t of toasts.toasts(); track t.id) {
        <div class="alert alert-{{ t.kind }} shadow-sm py-2 px-3 mb-2 d-flex align-items-center gap-2" role="status">
          <span class="flex-grow-1">{{ t.text }}</span>
          <button type="button" class="btn-close" aria-label="Close" (click)="toasts.dismiss(t.id)"></button>
        </div>
      }
    </div>
  `,
})
export class ToastContainer {
  protected readonly toasts = inject(ToastService);
}
