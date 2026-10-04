import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../auth/auth.service';
import { API_URL } from '../config';
import { authGuard } from '../guards/auth.guard';
import { authInterceptor } from './auth.interceptor';

describe('authInterceptor', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;
  let auth: AuthService;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('scalecart.token', 'tok123');
    localStorage.setItem('scalecart.user', JSON.stringify({ id: 'u', email: 'a@b.c', role: 'CUSTOMER' }));
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
  });

  it('adds the bearer token to API calls only', () => {
    http.get(`${API_URL}/cart`).subscribe();
    expect(ctrl.expectOne(`${API_URL}/cart`).request.headers.get('Authorization')).toBe('Bearer tok123');

    http.get('https://other.example.com/x').subscribe();
    expect(ctrl.expectOne('https://other.example.com/x').request.headers.has('Authorization')).toBe(false);
  });

  it('logs out and redirects to /login when the API says 401', () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    expect(auth.isLoggedIn()).toBe(true);
    http.get(`${API_URL}/orders`).subscribe({ error: () => undefined });
    ctrl.expectOne(`${API_URL}/orders`).flush({ error: 'invalid_token' }, { status: 401, statusText: 'Unauthorized' });
    expect(auth.isLoggedIn()).toBe(false);
    expect(navigate).toHaveBeenCalledWith(['/login'], expect.objectContaining({ queryParams: expect.anything() }));
  });

  it('does NOT log out on a wrong-password 401 from /auth/login', () => {
    http.post(`${API_URL}/auth/login`, {}).subscribe({ error: () => undefined });
    ctrl.expectOne(`${API_URL}/auth/login`).flush({ error: 'invalid_credentials' }, { status: 401, statusText: 'Unauthorized' });
    expect(auth.isLoggedIn()).toBe(true);
  });
});

describe('guards', () => {
  it('authGuard redirects anonymous users to /login with the return URL', () => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    const result = TestBed.runInInjectionContext(() => authGuard({} as never, { url: '/cart' } as never));
    expect(String(result)).toBe('/login?returnUrl=%2Fcart');
  });
});
