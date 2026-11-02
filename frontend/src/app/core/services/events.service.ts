import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { API_URL } from '../config';
import { DlqView, EventsOverview, Projections } from '../models';

/** Admin > Events: ScaleLog broker, consumer groups, DLQ and the projections the consumers build. */
@Injectable({ providedIn: 'root' })
export class EventsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${API_URL}/admin/events`;

  overview(): Observable<EventsOverview> {
    return this.http.get<EventsOverview>(this.base);
  }
  projections(): Observable<Projections> {
    return this.http.get<Projections>(`${this.base}/projections`);
  }
  dlq(group: string): Observable<DlqView> {
    return this.http.get<DlqView>(`${this.base}/dlq/${group}`);
  }
  replay(group: string): Observable<{ replayed: number }> {
    return this.http.post<{ replayed: number }>(`${this.base}/dlq/${group}/replay`, {});
  }
  setChaos(group: string, on: boolean): Observable<unknown> {
    return this.http.put(`${this.base}/chaos/${group}`, { on });
  }
}
