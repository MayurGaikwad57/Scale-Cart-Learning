import { HttpClient } from '@angular/common/http';
import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Observable, tap } from 'rxjs';
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

  markAllRead(): Observable<void> {
    return this.http.post<void>(`${API_URL}/notifications/read-all`, {}).pipe(
      // Only the badge resets now; the open list keeps highlighting what was new until the next refresh.
      tap(() => this.unread.set(0)),
    );
  }
}
