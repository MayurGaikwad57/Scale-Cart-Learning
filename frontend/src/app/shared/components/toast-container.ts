import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ToastService } from '../../core/services/toast.service';
import { Icon } from './icon';

@Component({
  selector: 'app-toast-container',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toast-stack" aria-live="polite">
      @for (t of toasts.toasts(); track t.id) {
        <div class="sc-toast sc-toast-{{ t.kind }}" role="status">
          <app-icon [name]="t.kind === 'danger' ? 'alert' : t.kind === 'info' ? 'info' : 'checkCircle'" [size]="20" />
          <span class="flex-grow-1">{{ t.text }}</span>
          <button type="button" class="sc-iconbtn" style="width: 28px; height: 28px" aria-label="Dismiss" (click)="toasts.dismiss(t.id)">
            <app-icon name="x" [size]="16" />
          </button>
        </div>
      }
    </div>
  `,
})
export class ToastContainer {
  protected readonly toasts = inject(ToastService);
}
