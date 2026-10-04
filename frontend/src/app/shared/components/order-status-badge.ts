import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { OrderStatus } from '../../core/models';

@Component({
  selector: 'app-order-status-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="badge text-bg-{{ color() }}">{{ status() }}</span>`,
})
export class OrderStatusBadge {
  readonly status = input.required<OrderStatus>();
  protected readonly color = computed(() => ({ CONFIRMED: 'success', CANCELLED: 'danger', PENDING: 'secondary' })[this.status()]);
}
