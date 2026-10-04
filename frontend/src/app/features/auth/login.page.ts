import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { errorMessage } from '../../core/http-error';
import { Icon } from '../../shared/components/icon';
import { safeReturnUrl } from './return-url';

@Component({
  selector: 'app-login-page',
  imports: [ReactiveFormsModule, RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sc-auth">
      <div class="sc-auth-side">
        <a class="sc-brand" style="color: #fff" routerLink="/"><span class="sc-logo" style="background: rgba(255,255,255,.2); box-shadow: none"><app-icon name="bag" [size]="19" /></span> ScaleCart</a>
        <div>
          <h2>Welcome back.<br />Pick up where you left off.</h2>
          <ul class="list-unstyled mt-4 mb-0">
            <li><app-icon name="checkCircle" [size]="20" /> Your cart is saved to your account</li>
            <li><app-icon name="checkCircle" [size]="20" /> Track every order you have placed</li>
            <li><app-icon name="checkCircle" [size]="20" /> Stock is held for you at checkout</li>
          </ul>
        </div>
        <div class="small" style="color: rgba(255,255,255,.7)">A learning project: modular monolith → microservices.</div>
      </div>
      <div class="sc-auth-form">
        <div class="inner">
          <h1 class="fw-bold mb-1" style="font-size: 1.9rem">Log in</h1>
          <p class="sc-muted mb-4">Enter your details to continue.</p>
          @if (error()) {
            <div class="sc-alert sc-alert-danger mb-3" role="alert"><app-icon name="alert" [size]="20" /><span>{{ error() }}</span></div>
          }
          <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
            <div class="mb-3">
              <label class="form-label" for="email">Email</label>
              <input id="email" type="email" class="form-control" formControlName="email" autocomplete="username" placeholder="you@example.com"
                [class.is-invalid]="invalid('email')" />
              @if (invalid('email')) { <div class="invalid-feedback">Enter a valid email address.</div> }
            </div>
            <div class="mb-4">
              <label class="form-label" for="password">Password</label>
              <input id="password" type="password" class="form-control" formControlName="password" autocomplete="current-password" placeholder="Your password"
                [class.is-invalid]="invalid('password')" />
              @if (invalid('password')) { <div class="invalid-feedback">Password is required.</div> }
            </div>
            <button class="sc-btn sc-btn-primary sc-btn-lg sc-btn-block" type="submit" [disabled]="submitting()">
              @if (submitting()) { <span class="sc-spinner"></span> Logging in… } @else { Log in }
            </button>
          </form>
          <p class="mt-4 mb-3 text-center sc-muted">New here? <a routerLink="/register" class="fw-semibold">Create an account</a></p>
          <div class="sc-demo d-flex align-items-center justify-content-between gap-2">
            <span><b>Demo admin</b> (made by <code>npm run seed</code>)<br />admin&#64;scalecart.com · Admin&#64;12345</span>
            <button type="button" class="sc-btn sc-btn-soft sc-btn-sm" (click)="fillAdmin()">Fill</button>
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
