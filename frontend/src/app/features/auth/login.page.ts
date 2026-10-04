import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { errorMessage } from '../../core/http-error';
import { safeReturnUrl } from './return-url';

@Component({
  selector: 'app-login-page',
  imports: [ReactiveFormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="row justify-content-center">
      <div class="col-md-6 col-lg-5">
        <div class="card shadow-sm">
          <div class="card-body p-4">
            <h1 class="h4 mb-3">Log in</h1>
            @if (error()) {
              <div class="alert alert-danger" role="alert">{{ error() }}</div>
            }
            <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
              <div class="mb-3">
                <label class="form-label" for="email">Email</label>
                <input id="email" type="email" class="form-control" formControlName="email" autocomplete="username"
                  [class.is-invalid]="invalid('email')" />
                @if (invalid('email')) {
                  <div class="invalid-feedback">Enter a valid email address.</div>
                }
              </div>
              <div class="mb-3">
                <label class="form-label" for="password">Password</label>
                <input id="password" type="password" class="form-control" formControlName="password" autocomplete="current-password"
                  [class.is-invalid]="invalid('password')" />
                @if (invalid('password')) {
                  <div class="invalid-feedback">Password is required.</div>
                }
              </div>
              <button class="btn btn-primary w-100" type="submit" [disabled]="submitting()">
                {{ submitting() ? 'Logging in…' : 'Log in' }}
              </button>
            </form>
            <p class="mt-3 mb-0 small">No account? <a routerLink="/register">Register</a></p>
          </div>
        </div>
        <div class="card mt-3 border-info">
          <div class="card-body small">
            <strong>Demo admin</strong> (created by <code>npm run seed</code> in the backend):<br />
            admin&#64;scalecart.com / Admin&#64;12345
            <button type="button" class="btn btn-sm btn-outline-info ms-2" (click)="fillAdmin()">Fill</button>
          </div>
        </div>
      </div>
    </div>
  `,
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly form = inject(NonNullableFormBuilder).group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', Validators.required],
  });
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected invalid(name: 'email' | 'password'): boolean {
    const c = this.form.controls[name];
    return c.invalid && (c.touched || c.dirty);
  }

  protected fillAdmin(): void {
    this.form.setValue({ email: 'admin@scalecart.com', password: 'Admin@12345' });
  }

  protected submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.error.set(null);
    const { email, password } = this.form.getRawValue();
    this.auth.login(email, password).subscribe({
      next: () => void this.router.navigateByUrl(safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'))),
      error: (e) => {
        this.error.set(errorMessage(e));
        this.submitting.set(false);
      },
    });
  }
}
