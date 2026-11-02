import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { API_URL } from '../config';
import { AppNotification } from '../models';
import { NotificationsService } from './notifications.service';

const note = (id: string, read: boolean): AppNotification => ({ id, orderId: null, title: 't', body: 'b', read, createdAt: '2026-11-02T10:00:00Z' });

describe('NotificationsService.open (bell)', () => {
  let svc: NotificationsService;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear(); // logged out: no polling in the background
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    svc = TestBed.inject(NotificationsService);
    http = TestBed.inject(HttpTestingController);
  });

  it('loads the list FIRST, then marks exactly the unread ones that are shown', () => {
    svc.open().subscribe();
    // Nothing is marked before the list is on screen.
    http.expectNone(`${API_URL}/notifications/read`);
    http.expectOne(`${API_URL}/notifications`).flush({ items: [note('a', false), note('b', true), note('c', false)], unread: 2 });
    const mark = http.expectOne(`${API_URL}/notifications/read`);
    expect(mark.request.body).toEqual({ ids: ['a', 'c'] });
    mark.flush({ unread: 1 }); // one more arrived meanwhile: the badge keeps it
    expect(svc.unread()).toBe(1);
    expect(svc.items().filter((n) => !n.read).map((n) => n.id)).toEqual(['a', 'c']); // still highlighted
    http.verify();
  });

  it('marks nothing when everything shown is already read', () => {
    svc.open().subscribe();
    http.expectOne(`${API_URL}/notifications`).flush({ items: [note('a', true)], unread: 0 });
    http.expectNone(`${API_URL}/notifications/read`);
    http.verify();
  });
});
