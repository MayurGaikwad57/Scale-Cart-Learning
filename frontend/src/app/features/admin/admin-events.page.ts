import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { catchError, forkJoin, map, of, switchMap, tap, timer } from 'rxjs';
import { errorMessage } from '../../core/http-error';
import { DlqView, EventsOverview, Projections } from '../../core/models';
import { EventsService } from '../../core/services/events.service';
import { ToastService } from '../../core/services/toast.service';
import { Icon } from '../../shared/components/icon';
import { MoneyPipe } from '../../shared/pipes/money.pipe';

const REFRESH_MS = 3000;
const GROUPS = ['notification', 'inventory', 'analytics'] as const;
const GROUP_INFO: Record<string, string> = {
  notification: 'Tells the customer: the bell in the navbar',
  inventory: 'Flags products that run low after a sale',
  analytics: 'Builds the daily sales report below',
};

interface Snapshot {
  overview: EventsOverview;
  projections: Projections;
  dlq: Record<string, DlqView | null>;
}

/**
 * Admin > Events: a live look inside ScaleLog (our own Kafka). Refreshes every 3s.
 * Things to try are listed at the bottom of the page.
 */
@Component({
  selector: 'app-admin-events-page',
  imports: [RouterLink, Icon, DatePipe, MoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="d-flex flex-wrap justify-content-between align-items-end gap-3 mb-4">
      <div>
        <div class="sc-eyebrow">Admin</div>
        <h1 class="sc-page-title">Events</h1>
        <p class="sc-muted mb-0">Every order publishes an <code>OrderCreated</code> event. Three consumer groups react to it independently.</p>
      </div>
      <div class="d-flex flex-wrap gap-2">
        <a routerLink="/admin/system" class="sc-btn sc-btn-soft"><app-icon name="zap" [size]="18" /> System status</a>
        <a routerLink="/admin/products" class="sc-btn sc-btn-soft"><app-icon name="grid" [size]="18" /> Products</a>
      </div>
    </div>

    @if (error()) {
      <div class="sc-alert sc-alert-danger mb-3" role="alert"><app-icon name="alert" [size]="20" /><span>{{ error() }}</span></div>
    }

    @if (data(); as d) {
      <!-- Broker -->
      <div class="sc-card sc-card-pad mb-4">
        <div class="d-flex flex-wrap align-items-center gap-3">
          <span class="sc-option-icon" [style.background]="d.overview.broker.status === 'ready' ? 'var(--sc-success-50)' : 'var(--sc-danger-50)'"
            [style.color]="d.overview.broker.status === 'ready' ? 'var(--sc-success)' : 'var(--sc-danger)'"><app-icon name="activity" [size]="22" /></span>
          <div class="flex-grow-1">
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <h2 class="h5 mb-0">ScaleLog broker</h2>
              <span class="sc-pill" [class]="d.overview.broker.status === 'ready' ? 'sc-pill-success' : 'sc-pill-danger'" data-testid="broker-status">
                {{ d.overview.broker.status === 'ready' ? 'Connected' : d.overview.broker.status === 'disabled' ? 'Not configured' : 'Down' }}
              </span>
            </div>
            <div class="sc-muted small">Our own Kafka-like log · {{ d.overview.broker.url ?? 'LOG_URL is empty' }}</div>
          </div>
          @if (d.overview.cluster; as c) {
            <div class="sc-kpis">
              <div><b>{{ c.stats.produced }}</b><span>produced</span></div>
              <div><b>{{ c.stats.commits }}</b><span>commits</span></div>
              <div><b>{{ c.stats.rebalances }}</b><span>rebalances</span></div>
            </div>
          }
        </div>
        @if (d.overview.publisher.notPublished > 0) {
          <div class="sc-alert sc-alert-warn mt-3 mb-0">
            <app-icon name="alert" [size]="20" />
            <span><b>{{ d.overview.publisher.notPublished }}</b> order event(s) could not be published (broker was down). Those orders exist, but nobody was notified.
              This is the <b>dual-write problem</b>, which the Outbox pattern fixes in M7.</span>
          </div>
        }
        @if (d.overview.broker.status !== 'ready') {
          <div class="sc-alert sc-alert-warn mt-3 mb-0">
            <app-icon name="info" [size]="20" />
            <span>Checkout still works without the broker. Start it with <code>npm run log</code> in the <code>backend</code> folder; the API reconnects by itself.</span>
          </div>
        }
      </div>

      @if (d.overview.cluster; as c) {
        <!-- Topic -->
        @for (t of c.topics; track t.name) {
          @if (t.name === 'orders') {
            <div class="sc-card sc-card-pad mb-4">
              <div class="d-flex justify-content-between align-items-baseline flex-wrap gap-2 mb-3">
                <h2 class="h6 mb-0">Topic <code>orders</code> · {{ t.partitions.length }} partitions</h2>
                <span class="sc-muted small">Same order id → same partition → processed in order</span>
              </div>
              <div class="sc-parts">
                @for (p of t.partitions; track p.partition) {
                  <div class="sc-part">
                    <div class="sc-muted small">Partition {{ p.partition }}</div>
                    <div class="sc-part-num">{{ p.endOffset }}</div>
                    <div class="sc-muted small">events</div>
                  </div>
                }
              </div>
            </div>
          }
        }

        <!-- Consumer groups -->
        <div class="row g-4 mb-4">
          @for (name of groups; track name) {
            @let g = group(c, name);
            @let dlq = d.dlq[name];
            <div class="col-lg-4">
              <div class="sc-card sc-card-pad h-100 d-flex flex-column" [attr.data-testid]="'group-' + name">
                <div class="d-flex justify-content-between align-items-start gap-2">
                  <div>
                    <h2 class="h6 mb-0">{{ name }}</h2>
                    <div class="sc-muted small">{{ info[name] }}</div>
                  </div>
                  <span class="sc-pill text-nowrap flex-shrink-0" [class]="totalLag(g) === 0 ? 'sc-pill-success' : 'sc-pill-warn'" [attr.data-testid]="'lag-' + name">lag {{ totalLag(g) }}</span>
                </div>

                <div class="small mt-3 mb-1 fw-semibold">Members (generation {{ g?.generation ?? 0 }})</div>
                @for (m of g?.members ?? []; track m.id) {
                  <div class="sc-member small">
                    <code class="text-truncate">{{ shortMember(m.id) }}</code>
                    <span class="sc-chip-sm">{{ m.partitions.length ? 'partitions ' + m.partitions.join(', ') : 'idle' }}</span>
                  </div>
                } @empty {
                  <div class="sc-muted small">No running consumer. Events wait in the log.</div>
                }

                <table class="sc-table sc-table-compact mt-2">
                  <thead><tr><th>Partition</th><th class="text-end">Committed</th><th class="text-end">Lag</th></tr></thead>
                  <tbody>
                    @for (p of g?.partitions ?? []; track p.partition) {
                      <tr><td>{{ p.partition }}</td><td class="text-end">{{ p.committed }} / {{ p.endOffset }}</td><td class="text-end">{{ p.lag }}</td></tr>
                    }
                  </tbody>
                </table>

                <div class="mt-auto pt-3">
                  <label class="sc-switch">
                    <input type="checkbox" [checked]="d.overview.chaos[name]" [disabled]="!d.overview.chaosAvailable || busy()"
                      (change)="toggleChaos(name, $any($event.target).checked)" [attr.data-testid]="'chaos-' + name" />
                    <span class="sc-switch-track"></span>
                    <span class="small"><b>Chaos:</b> make this consumer fail</span>
                  </label>
                  @if (!d.overview.chaosAvailable) { <div class="sc-muted small mt-1">Needs ScaleKV (npm run kv).</div> }

                  <div class="sc-dlq mt-3">
                    <div class="d-flex justify-content-between align-items-center gap-2">
                      <span class="small"><b>Dead-letter queue:&nbsp;</b><span [attr.data-testid]="'dlq-' + name">{{ dlq?.waiting?.length ?? 0 }}</span> waiting</span>
                      <button class="sc-btn sc-btn-soft sc-btn-sm" type="button" [disabled]="!dlq?.waiting?.length || busy()" (click)="replay(name)" [attr.data-testid]="'replay-' + name">
                        <app-icon name="refresh" [size]="15" /> Replay
                      </button>
                    </div>
                    @for (w of dlq?.waiting ?? []; track w.offset) {
                      <div class="sc-dlq-item small">
                        <div>
                          @if (w.orderId) { Order <code>#{{ w.orderId.slice(0, 8).toUpperCase() }}</code> } @else { {{ w.type || 'Unknown event' }} }
                          · {{ w.attempts }} attempts
                        </div>
                        <div class="sc-danger-text">{{ w.error }}</div>
                      </div>
                    }
                  </div>
                </div>
              </div>
            </div>
          }
        </div>
      }

      <!-- Projections -->
      <div class="row g-4 mb-4">
        <div class="col-lg-7">
          <div class="sc-card overflow-hidden h-100">
            <div class="sc-card-pad pb-2">
              <h2 class="h6 mb-0">Daily sales <span class="sc-muted fw-normal">(built only from events by "analytics")</span></h2>
            </div>
            <div class="table-responsive">
              <table class="sc-table">
                <thead><tr><th>Day (UTC)</th><th class="text-end">Confirmed</th><th class="text-end">Cancelled</th><th class="text-end">Revenue</th></tr></thead>
                <tbody>
                  @for (s of d.projections.sales; track s.day) {
                    <tr><td>{{ s.day }}</td><td class="text-end">{{ s.confirmedOrders }}</td><td class="text-end">{{ s.cancelledOrders }}</td><td class="text-end fw-semibold">{{ s.revenueCents | money }}</td></tr>
                  } @empty {
                    <tr><td colspan="4" class="text-center sc-muted py-4">No events processed yet. Place an order.</td></tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div class="col-lg-5">
          <div class="sc-card overflow-hidden h-100">
            <div class="sc-card-pad pb-2">
              <h2 class="h6 mb-0">Low-stock alerts <span class="sc-muted fw-normal">(by "inventory", ≤ 5 left)</span></h2>
            </div>
            <table class="sc-table">
              <tbody>
                @for (a of d.projections.stockAlerts; track a.productId) {
                  <tr>
                    <td><div class="fw-semibold">{{ a.name }}</div><div class="sc-muted small">{{ a.sku }} · {{ a.updatedAt | date: 'MMM d, h:mm a' }}</div></td>
                    <td class="text-end"><span class="sc-pill" [class]="a.available === 0 ? 'sc-pill-danger' : 'sc-pill-warn'">{{ a.available }} left</span></td>
                  </tr>
                } @empty {
                  <tr><td class="text-center sc-muted py-4">All products are well stocked.</td></tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="sc-card sc-card-pad">
        <h2 class="h6">Try it</h2>
        <ol class="small mb-0 sc-try">
          <li><b>Rebalancing:</b> in a new terminal run <code>cd backend; npm run worker</code>. Each group's members split the 3 partitions. Ctrl+C the worker and the partitions move back.</li>
          <li><b>Retry → DLQ → replay:</b> switch on <i>Chaos</i> for <i>notification</i>, place an order: it is retried 3× and lands in the DLQ, while <i>analytics</i> still counts it. Switch chaos off and press <i>Replay</i>: the notification arrives, and the other groups skip the replayed duplicate.</li>
          <li><b>Broker down:</b> stop <code>npm run log</code> and place an order. Checkout still works, but the event is missed (the dual-write problem). Start the broker again and everything reconnects.</li>
        </ol>
      </div>
    } @else if (!error()) {
      <div class="sc-card p-4">@for (n of [1, 2, 3]; track n) { <div class="sc-skel mb-3" style="height: 64px"></div> }</div>
    }
  `,
  styles: `
    .sc-kpis { display: flex; gap: 1.25rem; }
    .sc-kpis div { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.1; }
    .sc-kpis b { font-size: 1.25rem; font-variant-numeric: tabular-nums; }
    .sc-kpis span { font-size: 0.75rem; color: var(--sc-muted); }
    .sc-parts { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; }
    .sc-part { border: 1px solid var(--sc-line); border-radius: 12px; padding: 12px 14px; }
    .sc-part-num { font-size: 1.6rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .sc-member { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 0; min-width: 0; }
    .sc-member code { min-width: 0; }
    .sc-chip-sm { flex: 0 0 auto; background: #eef0f6; border-radius: 999px; padding: 2px 8px; font-size: 0.75rem; }
    .sc-table-compact td, .sc-table-compact th { padding: 6px 4px; font-size: 0.82rem; }
    .sc-dlq { border-top: 1px dashed var(--sc-line); padding-top: 12px; }
    .sc-dlq-item { background: var(--sc-danger-50); border-radius: 8px; padding: 6px 8px; margin-top: 6px; }
    .sc-danger-text { color: #be123c; }
    .sc-switch { display: flex; align-items: center; gap: 10px; cursor: pointer; }
    .sc-switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
    .sc-switch-track { flex: 0 0 auto; width: 38px; height: 22px; border-radius: 999px; background: #d6d9e4; position: relative; transition: background 0.2s; }
    .sc-switch-track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,.25); }
    .sc-switch input:checked + .sc-switch-track { background: var(--sc-danger); }
    .sc-switch input:checked + .sc-switch-track::after { transform: translateX(16px); }
    .sc-switch input:focus-visible + .sc-switch-track { outline: 2px solid var(--sc-primary); outline-offset: 2px; }
    .sc-switch input:disabled + .sc-switch-track { opacity: 0.5; }
    .sc-try li { margin-bottom: 6px; }
    code { font-size: 0.85em; }
  `,
})
export class AdminEventsPage {
  private readonly events = inject(EventsService);
  private readonly toast = inject(ToastService);
  protected readonly groups = GROUPS;
  protected readonly info = GROUP_INFO;
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly data = toSignal<Snapshot | null>(
    timer(0, REFRESH_MS).pipe(
      switchMap(() =>
        this.events.overview().pipe(
          switchMap((overview) =>
            forkJoin({
              projections: this.events.projections(),
              // DLQs can only be read while the broker is up.
              dlq: overview.broker.status === 'ready'
                ? forkJoin(Object.fromEntries(GROUPS.map((g) => [g, this.events.dlq(g).pipe(catchError(() => of(null)))])))
                : of(Object.fromEntries(GROUPS.map((g) => [g, null]))),
            }).pipe(map((rest) => ({ overview, ...rest }) as Snapshot)),
          ),
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

  protected group(c: NonNullable<EventsOverview['cluster']>, name: string) {
    return c.groups.find((g) => g.group === name);
  }

  protected totalLag(g: ReturnType<AdminEventsPage['group']>): number {
    return g?.partitions.reduce((s, p) => s + p.lag, 0) ?? 0;
  }

  /** "notification-HOST-1234-ab12cd" -> "HOST · pid 1234": which process is this member? */
  protected shortMember(id: string): string {
    const parts = id.split('-');
    return parts.length >= 4 ? `${parts.slice(1, -2).join('-')} · pid ${parts.at(-2)}` : id;
  }

  protected toggleChaos(group: string, on: boolean): void {
    this.busy.set(true);
    this.events.setChaos(group, on).subscribe({
      next: () => {
        this.toast.show(on ? `Chaos ON: "${group}" will now fail every event` : `Chaos OFF for "${group}"`, on ? 'danger' : 'success');
        this.busy.set(false);
      },
      error: (e) => {
        this.toast.show(errorMessage(e), 'danger', 4000);
        this.busy.set(false);
      },
    });
  }

  protected replay(group: string): void {
    this.busy.set(true);
    this.events.replay(group).subscribe({
      next: (r) => {
        this.toast.show(`${r.replayed} event(s) put back on the "orders" topic`);
        this.busy.set(false);
      },
      error: (e) => {
        this.toast.show(errorMessage(e), 'danger', 4000);
        this.busy.set(false);
      },
    });
  }
}
