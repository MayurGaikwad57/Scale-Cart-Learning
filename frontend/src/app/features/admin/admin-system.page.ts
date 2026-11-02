import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { catchError, of, switchMap, tap, timer } from 'rxjs';
import { errorMessage } from '../../core/http-error';
import { KvStatus, SystemStatus } from '../../core/models';
import { SystemService } from '../../core/services/system.service';
import { Icon } from '../../shared/components/icon';

const REFRESH_MS = 3000;

/**
 * Admin > System: live numbers from ScaleKV, our own Redis-like key-value store.
 * Refreshes every 3 seconds, so you can browse the shop in another tab and watch the
 * hit rate climb (first visit of a product = miss, later visits = hits).
 */
@Component({
  selector: 'app-admin-system-page',
  imports: [RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="d-flex flex-wrap justify-content-between align-items-end gap-3 mb-4">
      <div>
        <div class="sc-eyebrow">Admin</div>
        <h1 class="sc-page-title">System</h1>
        <p class="sc-muted mb-0">Cache and rate-limit health. Updates every {{ refreshSeconds }} seconds.</p>
      </div>
      <div class="d-flex flex-wrap gap-2">
        <a routerLink="/admin/events" class="sc-btn sc-btn-soft"><app-icon name="activity" [size]="18" /> Events</a>
        <a routerLink="/admin/products" class="sc-btn sc-btn-soft"><app-icon name="grid" [size]="18" /> Manage products</a>
      </div>
    </div>

    @if (error()) {
      <div class="sc-alert sc-alert-danger mb-3" role="alert"><app-icon name="alert" [size]="20" /><span>{{ error() }}</span></div>
    }

    @if (status(); as s) {
      <div class="sc-card sc-card-pad mb-4">
        <div class="d-flex flex-wrap align-items-center gap-3">
          <span class="sc-option-icon" [style.background]="tone().bg" [style.color]="tone().fg"><app-icon name="zap" [size]="22" /></span>
          <div class="flex-grow-1">
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <h2 class="h5 mb-0">ScaleKV</h2>
              <span class="sc-pill" [class]="tone().pill" data-testid="kv-status">{{ tone().label }}</span>
            </div>
            <div class="sc-muted small">Our own Redis-like key-value store · {{ s.kv.url ?? 'not configured (KV_URL is empty)' }}</div>
          </div>
        </div>
        @if (s.kv.status !== 'ready') {
          <div class="sc-alert sc-alert-warn mt-3 mb-0">
            <app-icon name="info" [size]="20" />
            <span>
              The shop still works: products are read straight from PostgreSQL and rate limits are switched off (fail open).
              Start it with <code>npm run kv</code> in the <code>backend</code> folder; the API reconnects by itself.
            </span>
          </div>
        }
      </div>

      <div class="sc-stats mb-4">
        <div class="sc-card sc-stat">
          <div class="sc-stat-label">Product cache hit rate</div>
          <div class="sc-stat-value" data-testid="hit-rate">{{ s.cache.hitRatePercent }}%</div>
          <div class="sc-meter" role="meter" aria-label="Product cache hit rate" [attr.aria-valuenow]="s.cache.hitRatePercent" aria-valuemin="0" aria-valuemax="100">
            <span [style.width.%]="s.cache.hitRatePercent"></span>
          </div>
          <div class="sc-stat-note">{{ s.cache.hits }} hits · {{ s.cache.misses }} misses · {{ s.cache.bypass }} bypassed</div>
        </div>
        @if (s.kv.stats; as k) {
          <div class="sc-card sc-stat">
            <div class="sc-stat-label">Keys stored</div>
            <div class="sc-stat-value">{{ k.keys }}</div>
            <div class="sc-stat-note">of max {{ k.maxKeys }} · {{ k.keysWithTtl }} with TTL</div>
          </div>
          <div class="sc-card sc-stat">
            <div class="sc-stat-label">Expired / evicted</div>
            <div class="sc-stat-value">{{ k.expiredKeys }} / {{ k.evictedKeys }}</div>
            <div class="sc-stat-note">TTL ran out / dropped by LRU</div>
          </div>
          <div class="sc-card sc-stat">
            <div class="sc-stat-label">Commands processed</div>
            <div class="sc-stat-value">{{ k.commandsProcessed }}</div>
            <div class="sc-stat-note">{{ k.connectedClients }} client(s) · up {{ uptime() }}</div>
          </div>
        }
      </div>

      <div class="row g-4">
        <div class="col-lg-6">
          <div class="sc-card overflow-hidden h-100">
            <div class="sc-card-pad pb-2"><h2 class="h6 mb-0">Cache lifetimes (TTL)</h2></div>
            <table class="sc-table">
              <tbody>
                <tr><td>Product page</td><td class="text-end fw-semibold">{{ s.cache.productTtlSeconds }}s</td></tr>
                <tr><td>Catalog list page</td><td class="text-end fw-semibold">{{ s.cache.listTtlSeconds }}s</td></tr>
                <tr><td>Categories</td><td class="text-end fw-semibold">{{ s.cache.categoriesTtlSeconds }}s</td></tr>
                <tr><td>"Not found" answers</td><td class="text-end fw-semibold">{{ s.cache.notFoundTtlSeconds }}s</td></tr>
              </tbody>
            </table>
            <p class="sc-muted small sc-card-pad pt-2 mb-0">
              Tip: open DevTools → Network and click a product. The <code>X-Cache</code> response header says HIT, MISS or BYPASS.
            </p>
          </div>
        </div>
        <div class="col-lg-6">
          <div class="sc-card overflow-hidden h-100">
            <div class="sc-card-pad pb-2"><h2 class="h6 mb-0">Rate limits</h2></div>
            <div class="table-responsive">
              <table class="sc-table">
                <thead><tr><th>Rule</th><th>Limit</th><th>Per</th></tr></thead>
                <tbody>
                  @for (r of s.rateLimits; track r.name) {
                    <tr>
                      <td><div class="fw-semibold">{{ r.name }}</div><div class="sc-muted small">{{ r.appliesTo }}</div></td>
                      <td class="text-nowrap">{{ r.limit }} / {{ r.window }}</td>
                      <td>{{ r.per }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    } @else if (!error()) {
      <div class="sc-card p-4">
        @for (n of [1, 2, 3]; track n) { <div class="sc-skel mb-3" style="height: 56px"></div> }
      </div>
    }
  `,
  styles: `
    .sc-stats { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
    .sc-stat { padding: 18px 20px; }
    .sc-stat-label { font-size: 0.8rem; font-weight: 600; color: var(--sc-muted, #64748b); text-transform: uppercase; letter-spacing: 0.04em; }
    .sc-stat-value { font-size: 1.75rem; font-weight: 700; line-height: 1.2; margin: 6px 0 4px; font-variant-numeric: tabular-nums; }
    .sc-stat-note { font-size: 0.85rem; color: var(--sc-muted, #64748b); }
    .sc-meter { height: 8px; border-radius: 999px; background: #eef0f6; overflow: hidden; margin: 8px 0; }
    .sc-meter span { display: block; height: 100%; border-radius: inherit; background: var(--sc-success); transition: width 0.4s ease; }
    code { font-size: 0.85em; }
  `,
})
export class AdminSystemPage {
  private readonly system = inject(SystemService);
  protected readonly refreshSeconds = REFRESH_MS / 1000;
  protected readonly error = signal<string | null>(null);

  protected readonly status = toSignal<SystemStatus | null>(
    timer(0, REFRESH_MS).pipe(
      switchMap(() =>
        this.system.status().pipe(
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

  private static readonly TONES: Record<KvStatus, { label: string; pill: string; bg: string; fg: string }> = {
    ready: { label: 'Connected', pill: 'sc-pill-success', bg: 'var(--sc-success-50)', fg: 'var(--sc-success)' },
    connecting: { label: 'Connecting…', pill: 'sc-pill-warn', bg: 'var(--sc-warn-50)', fg: '#b45309' },
    down: { label: 'Down - running without cache', pill: 'sc-pill-danger', bg: 'var(--sc-danger-50)', fg: 'var(--sc-danger)' },
    disabled: { label: 'Not configured', pill: 'sc-pill-neutral', bg: '#eef0f6', fg: '#475569' },
  };
  protected readonly tone = computed(() => AdminSystemPage.TONES[this.status()?.kv.status ?? 'disabled']);

  protected readonly uptime = computed(() => {
    const s = this.status()?.kv.stats?.uptimeSeconds ?? 0;
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  });
}
