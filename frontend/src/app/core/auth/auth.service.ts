import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, catchError, of, tap } from 'rxjs';
import { API_URL } from '../config';
import { AuthResponse, User } from '../models';

const TOKEN_KEY = 'scalecart.token';
const USER_KEY = 'scalecart.user';

/**
 * STATE DECISION: the logged-in user is a *Signal* held in a root service.
 * - It is synchronous app-wide state read from templates, guards and other services,
 *   which is exactly what signals are for (no subscribe/async pipe needed).
 * - The HTTP calls themselves stay Observables (async, cancellable, one-shot).
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  private readonly _user = signal<User | null>(this.readStoredUser());
  readonly user = this._user.asReadonly();
  readonly isLoggedIn = computed(() => this._user() !== null);
  readonly isAdmin = computed(() => this._user()?.role === 'ADMIN');

  get token(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  login(email: string, password: string): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${API_URL}/auth/login`, { email, password }).pipe(tap((r) => this.setSession(r)));
  }

  register(email: string, password: string): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${API_URL}/auth/register`, { email, password }).pipe(tap((r) => this.setSession(r)));
  }

  logout(): void {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch {
      /* storage unavailable: nothing to clear */
    }
    this._user.set(null);
  }

  /** On app start: if a token is stored, ask the server who it belongs to (drops expired/invalid tokens). */
  restore(): Observable<unknown> {
    if (!this.token) return of(null);
    return this.http.get<{ user: User }>(`${API_URL}/auth/me`).pipe(
      tap(({ user }) => this.storeUser(user)),
      // 401 is handled by the interceptor (logout). Network errors keep the stored session.
      catchError(() => of(null)),
    );
  }

  private setSession({ user, token }: AuthResponse): void {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* ignore: session lasts until reload */
    }
    this.storeUser(user);
  }

  private storeUser(user: User): void {
    try {
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch {
      /* ignore */
    }
    this._user.set(user);
  }

  private readStoredUser(): User | null {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw && localStorage.getItem(TOKEN_KEY) ? (JSON.parse(raw) as User) : null;
    } catch {
      return null;
    }
  }
}
