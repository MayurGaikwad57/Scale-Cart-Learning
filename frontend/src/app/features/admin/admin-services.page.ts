import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { catchError, forkJoin, map, of, switchMap, tap, timer } from 'rxjs';
import { errorMessage } from '../../core/http-error';
import { PaymentsOverview, ServicesOverview, ServiceStatus } from '../../core/models';
import { ServicesService } from '../../core/services/services.service';
import { Icon, IconName } from '../../shared/components/icon';
import { MoneyPipe } from '../../shared/pipes/money.pipe';

const REFRESH_MS = 2000;

const INFO: Record<ServiceStatus['service'], { title: string; icon: IconName; port: number; owns: string; script: string }> = {
  identity: { title: 'Identity service', icon: 'shield', port: 3005, owns: 'users (database scalecart_identity)', script: 'npm run dev -w @scalecart/identity' },
  catalog: { title: 'Catalog service', icon: 'grid', port: 3006, owns: 'products (database scalecart_catalog)', script: 'npm run dev -w @scalecart/catalog' },
  order: { title: 'Order service', icon: 'package', port: 3001, owns: 'cart, orders (database scalecart_order)', script: 'npm run dev -w @scalecart/order' },
  payment: { title: 'Payment service', icon: 'card', port: 3002, owns: 'payments (database scalecart_payment)', script: 'npm run dev -w @scalecart/payment' },
  inventory: { title: 'Inventory service', icon: 'layers', port: 3003, owns: 'stock, reservations (database scalecart_inventory)', script: 'npm run dev -w @scalecart/inventory' },
  notification: { title: 'Notification service', icon: 'bell', port: 3004, owns: 'notifications (database scalecart_notification)', script: 'npm run dev -w @scalecart/notification' },
};

interface Snapshot {
  overview: ServicesOverview;
  payments: PaymentsOverview | null;
}

/**
 * Admin > Services (M6): the microservices behind the API gateway, live. Refreshes every 2s.
 * Stop a service in its terminal and watch its card turn red - and the rest of the shop keep going.
 */
@Component({
  selector: 'app-admin-services-page',
  imports: [RouterLink, Icon, DatePipe, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="d-flex flex-wrap justify-content-between align-items-end gap-3 mb-4">
      <div>
        <div class="sc-eyebrow">Admin</div>
        <h1 class="sc-page-title">Services</h1>
        <p class="sc-muted mb-0">The browser talks only to the <b>API gateway</b> (:3000). It routes every request to one of six services, each with its own database. Updates every 2 seconds.</p>
      </div>
      <div class="d-flex flex-wrap gap-2">
        <a routerLink="/admin/events" class="sc-btn sc-btn-soft"><app-icon name="activity" [size]="18" /> Events</a>
        <a routerLink="/admin/system" class="sc-btn sc-btn-soft"><app-icon name="zap" [size]="18" /> System status</a>
      </div>
    </div>

    @if (error()) {
      <div class="sc-alert sc-alert-danger mb-3" role="alert"><app-icon name="alert" [size]="20" /><span>{{ error() }}</span></div>
    }

    @if (data(); as d) {
      <div class="sc-card sc-card-pad mb-4">
        <div class="d-flex flex-wrap align-items-center gap-3">
          <span class="sc-option-icon" style="background: var(--sc-success-50); color: var(--sc-success)"><app-icon name="zap" [size]="22" /></span>
          <div class="flex-grow-1">
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <h2 class="h5 mb-0">API gateway</h2>
              <span class="sc-pill sc-pill-success">Running</span>
              <span class="sc-chip-sm">:3000 · pid {{ d.overview.gateway.pid }} · up {{ uptime(d.overview.gateway.uptimeSeconds) }}</span>
            </div>
            <div class="sc-muted small">Routing · edge authentication · global rate limit · request ids · CORS. No business logic.</div>
          </div>
          <div class="text-end small">
            <div><b>{{ upCount(d.overview) }}</b> / {{ d.overview.services.length }} services up</div>
          </div>
        </div>
      </div>

      <div class="row g-4 mb-4">
        @for (s of d.overview.services; track s.service) {
          @let i = infoFor(s.service);
          <div class="col-md-6">
            <div class="sc-card sc-card-pad h-100" [class.sc-down]="!s.up" [attr.data-testid]="'service-' + s.service">
              <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
                <div class="d-flex gap-3 align-items-center">
                  <span class="sc-option-icon" [style.background]="s.up ? 'var(--sc-primary-50)' : 'var(--sc-danger-50)'" [style.color]="s.up ? 'var(--sc-primary)' : 'var(--sc-danger)'">
                    <app-icon [name]="i.icon" [size]="22" />
                  </span>
                  <div>
                    <h2 class="h6 mb-0">{{ i.title }}</h2>
                    <div class="sc-muted small">:{{ i.port }}{{ s.pid ? ' · pid ' + s.pid : '' }}{{ s.uptimeSeconds !== undefined ? ' · up ' + uptime(s.uptimeSeconds) : '' }}</div>
                  </div>
                </div>
                <span class="sc-pill text-nowrap" [class]="s.up ? 'sc-pill-success' : 'sc-pill-danger'" [attr.data-testid]="'status-' + s.service">
                  {{ s.up ? 'Up · ' + s.latencyMs + ' ms' : 'Down' }}
                </span>
              </div>

              @if (!s.up) {
                <div class="sc-alert sc-alert-warn small mb-2">
                  <app-icon name="info" [size]="18" />
                  <span>Not answering ({{ s.status }}). Its routes return 502; its events wait in the log. Start it with <code>{{ i.script }}</code>.</span>
                </div>
              }

              <div class="small mb-1"><span class="sc-muted">Owns data:&nbsp;</span>{{ i.owns }}</div>
              <div class="small mb-2"><span class="sc-muted">Routes:&nbsp;</span>
                @for (r of s.routes; track r) { <code class="me-1">{{ r }}</code> } @empty { <span class="sc-muted">none (events only)</span> }
              </div>

              @for (g of s.groups; track g.group) {
                @let live = consumer(s, g.group);
                <div class="sc-group small">
                  <div class="d-flex justify-content-between gap-2">
                    <span><b>{{ g.group }}</b>&nbsp;<span class="sc-muted">← topic {{ g.topic }}</span></span>
                    @if (live) { <span class="sc-chip-sm">{{ live.processed }} processed · partitions {{ live.partitions.join(', ') || '-' }}</span> }
                  </div>
                  <div class="sc-muted">{{ g.description }}</div>
                </div>
              }

              <div class="sc-traffic small mt-2">
                <span><b>{{ s.traffic.requests }}</b> requests</span>
                <span><b>{{ s.traffic.avgMs }}</b> ms avg</span>
                <span [class.sc-danger-text]="s.traffic.errors > 0"><b>{{ s.traffic.errors }}</b> errors</span>
                <span [class.sc-danger-text]="s.traffic.unavailable > 0"><b>{{ s.traffic.unavailable }}</b> × 502/504</span>
              </div>
            </div>
          </div>
        }
      </div>

      @if (d.payments; as p) {
        <div class="sc-card overflow-hidden mb-4">
          <div class="px-4 pt-3 pb-2 d-flex flex-wrap justify-content-between gap-2">
            <h2 class="h6 mb-0">Recent payments <span class="sc-muted fw-normal">(payment service · simulated provider latency {{ p.providerDelayMs }} ms)</span></h2>
            <div class="d-flex gap-2">
              @for (t of p.totals; track t.status) {
                <span class="sc-pill" [class]="t.status === 'SUCCEEDED' ? 'sc-pill-success' : 'sc-pill-danger'">{{ t.count }} {{ t.status.toLowerCase() }}</span>
              }
            </div>
          </div>
          <div class="table-responsive">
            <table class="sc-table sc-table-compact mb-0">
              <thead><tr><th>Time</th><th>Order</th><th>Method</th><th class="text-end">Amount</th><th>Status</th></tr></thead>
              <tbody>
                @for (r of p.recent; track r.id) {
                  <tr>
                    <td class="text-nowrap">{{ r.createdAt | date: 'HH:mm:ss' }}</td>
                    <td><code>#{{ r.orderId.slice(0, 8).toUpperCase() }}</code></td>
                    <td class="small">{{ r.method ?? '-' }}</td>
                    <td class="text-end">{{ r.amountCents | money }}</td>
                    <td><span class="sc-pill" [class]="r.status === 'SUCCEEDED' ? 'sc-pill-success' : 'sc-pill-danger'">{{ r.status === 'SUCCEEDED' ? 'Paid' : 'Declined' }}</span></td>
                  </tr>
                } @empty {
                  <tr><td colspan="5" class="text-center sc-muted py-4">No payments yet.</td></tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      }

      <div class="sc-card sc-card-pad">
        <h2 class="h6">Try it</h2>
        <ol class="small mb-0 sc-try">
          <li><b>One terminal per service:</b> instead of <code>npm run dev</code>, run <code>npm run kv</code>, <code>npm run log</code>, and each <code>npm run svc:…</code> in its own terminal.</li>
          <li><b>Payment service down:</b> stop <code>npm run svc:payment</code>, place an order. It stays <i>Pending</i> (stock reserved) and the shop keeps working. Start it again: the order is charged and confirmed.</li>
          <li><b>Inventory service down:</b> stop it and try to check out: a clear "try again" message, nothing charged, cart kept. Product pages still load (served by the order service).</li>
          <li><b>Notification service down:</b> the bell shows an error, checkout is unaffected; the notifications arrive when it is back.</li>
        </ol>
      </div>
    } @else if (!error()) {
      <div class="sc-card p-4">@for (n of [1, 2, 3]; track n) { <div class="sc-skel mb-3" style="height: 64px"></div> }</div>
    }
  `,
  styles: `
    .sc-down { border-color: var(--sc-danger); }
    .sc-group { border-top: 1px solid var(--sc-border, #e5e7eb); padding: 8px 0; }
    .sc-traffic { display: flex; flex-wrap: wrap; gap: 14px; border-top: 1px solid var(--sc-border, #e5e7eb); padding-top: 8px; }
    .sc-try li { margin-bottom: 6px; }
    code { font-size: 0.85em; }
  `,
})
export class AdminServicesPage {
  private readonly api = inject(ServicesService);
  /** A service this page doesn't know yet (added in the backend later) gets a plain card, not a crash. */
  protected infoFor(name: string) {
    return INFO[name as ServiceStatus['service']] ?? { title: `${name} service`, icon: 'grid' as IconName, port: 0, owns: '', script: `npm run dev -w @scalecart/${name}` };
  }
  protected readonly error = signal<string | null>(null);

  protected readonly data = toSignal<Snapshot | null>(
    timer(0, REFRESH_MS).pipe(
      switchMap(() =>
        forkJoin({
          overview: this.api.overview(),
          // The payment service may be down - the page must still show everything else.
          payments: this.api.payments().pipe(catchError(() => of(null))),
        }).pipe(
          map((s) => s as Snapshot),
          tap(() => this.error.set(null)),
          catchError((e) => {
            this.error.set(errorMessage(e));
            return of(null);
          }),
        ),
      ),
    ),
    { initialValue: null },
  );

  protected consumer(s: ServiceStatus, group: string) {
    return s.consumers?.find((c) => c.group === group);
  }

  protected upCount(o: ServicesOverview): number {
    return o.services.filter((s) => s.up).length;
  }

  protected uptime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
}
