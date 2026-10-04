import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { OrderStatus } from '../../core/models';

@Component({
  selector: 'app-order-status-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="sc-pill sc-pill-{{ color() }}">{{ label() }}</span>`,
})
export class OrderStatusBadge {
  readonly status = input.required<OrderStatus>();
  protected readonly color = computed(() => ({ CONFIRMED: 'success', CANCELLED: 'danger', PENDING: 'warn' })[this.status()]);
  protected readonly label = computed(() => ({ CONFIRMED: 'Confirmed', CANCELLED: 'Cancelled', PENDING: 'Pending' })[this.status()]);
}
