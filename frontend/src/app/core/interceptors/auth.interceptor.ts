import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { API_URL } from '../config';

/**
 * Runs on every HTTP request:
 *  1. adds "Authorization: Bearer <token>" (only for our own API, never third parties)
 *  2. if the API answers 401 on a protected call, the session is dead -> log out and go to /login
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!req.url.startsWith(API_URL)) return next(req);

  const token = auth.token;
  const authed = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

  return next(authed).pipe(
    catchError((err: unknown) => {
      const isCredentialCheck = req.url.endsWith('/auth/login') || req.url.endsWith('/auth/register');
      if (err instanceof HttpErrorResponse && err.status === 401 && !isCredentialCheck && token) {
        auth.logout();
        void router.navigate(['/login'], { queryParams: { returnUrl: router.url } });
      }
      return throwError(() => err);
    }),
  );
};
