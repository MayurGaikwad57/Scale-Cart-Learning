import { HttpClient } from '@angular/common/http';
import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Observable, map, of, switchMap, tap } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { API_URL } from '../config';
import { AppNotification } from '../models';

const POLL_MS = 10_000;

/**
 * STATE DECISION: notifications are a root *Signal* (navbar badge + dropdown read them).
 * They are produced ASYNCHRONOUSLY by a consumer group after checkout, so the page can't know
 * when one arrives - we poll every 10s while logged in. (Server push - WebSocket/SSE - is the
 * upgrade path; polling is simpler and enough here.)
 */
@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  readonly items = signal<AppNotification[]>([]);
  readonly unread = signal(0);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    effect(() => {
      const loggedIn = this.auth.isLoggedIn();
      untracked(() => {
        clearInterval(this.timer);
        if (!loggedIn) {
          this.items.set([]);
          this.unread.set(0);
          return;
        }
        this.refresh();
        this.timer = setInterval(() => this.refresh(), POLL_MS);
      });
    });
    inject(DestroyRef).onDestroy(() => clearInterval(this.timer));
  }

  refresh(): void {
    this.http.get<{ items: AppNotification[]; unread: number }>(`${API_URL}/notifications`).subscribe({
      next: (r) => {
        this.items.set(r.items);
        this.unread.set(r.unread);
      },
      error: () => undefined, // a failed poll is not worth bothering the user about
    });
  }

  /**
   * The bell was opened: load the latest list FIRST, then mark exactly the unread ones that are
   * now on screen. (Firing "read-all" in parallel could mark a notification the user never saw,
   * and a late GET could bring the old badge back - found in code review.)
   * The open list keeps highlighting what was new; only the badge count changes.
   */
  open(): Observable<void> {
    return this.http.get<{ items: AppNotification[]; unread: number }>(`${API_URL}/notifications`).pipe(
      tap((r) => {
        this.items.set(r.items);
        this.unread.set(r.unread);
      }),
      switchMap((r) => {
        const shown = r.items.filter((n) => !n.read).map((n) => n.id);
        if (shown.length === 0) return of(undefined);
        return this.http
          .post<{ unread: number }>(`${API_URL}/notifications/read`, { ids: shown })
          .pipe(map((res) => void this.unread.set(res.unread)));
      }),
    );
  }
}
