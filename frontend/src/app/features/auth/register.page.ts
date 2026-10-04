import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { AbstractControl, NonNullableFormBuilder, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { errorMessage } from '../../core/http-error';
import { Icon } from '../../shared/components/icon';

// Group-level validator: runs when either password field changes.
const passwordsMatch = (group: AbstractControl): ValidationErrors | null =>
  group.get('password')?.value === group.get('confirm')?.value ? null : { mismatch: true };

@Component({
  selector: 'app-register-page',
  imports: [ReactiveFormsModule, RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sc-auth">
      <div class="sc-auth-side">
        <a class="sc-brand" style="color: #fff" routerLink="/"><span class="sc-logo" style="background: rgba(255,255,255,.2); box-shadow: none"><app-icon name="bag" [size]="19" /></span> ScaleCart</a>
        <div>
          <h2>Create your account.<br />Start shopping in seconds.</h2>
          <ul class="list-unstyled mt-4 mb-0">
            <li><app-icon name="checkCircle" [size]="20" /> Free to join, nothing to install</li>
            <li><app-icon name="checkCircle" [size]="20" /> Reserve stock the moment you check out</li>
            <li><app-icon name="checkCircle" [size]="20" /> Full order history in one place</li>
          </ul>
        </div>
        <div class="small" style="color: rgba(255,255,255,.7)">A learning project: modular monolith → microservices.</div>
      </div>
      <div class="sc-auth-form">
        <div class="inner">
          <h1 class="fw-bold mb-1" style="font-size: 1.9rem">Create account</h1>
          <p class="sc-muted mb-4">It only takes a moment.</p>
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
            <div class="mb-3">
              <label class="form-label" for="password">Password</label>
              <input id="password" type="password" class="form-control" formControlName="password" autocomplete="new-password" placeholder="8 to 72 characters"
                [class.is-invalid]="invalid('password')" />
              @if (invalid('password')) { <div class="invalid-feedback">Password must be 8 to 72 characters.</div> }
            </div>
            <div class="mb-4">
              <label class="form-label" for="confirm">Confirm password</label>
              <input id="confirm" type="password" class="form-control" formControlName="confirm" autocomplete="new-password" placeholder="Repeat your password"
                [class.is-invalid]="invalid('confirm') || mismatch()" />
              @if (mismatch()) { <div class="invalid-feedback">Passwords do not match.</div> }
            </div>
            <button class="sc-btn sc-btn-primary sc-btn-lg sc-btn-block" type="submit" [disabled]="submitting()">
              @if (submitting()) { <span class="sc-spinner"></span> Creating account… } @else { Create account }
            </button>
          </form>
          <p class="mt-4 mb-0 text-center sc-muted">Already registered? <a routerLink="/login" class="fw-semibold">Log in</a></p>
        </div>
      </div>
    </div>
  `,
})
export class RegisterPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly form = inject(NonNullableFormBuilder).group(
    {
      email: ['', [Validators.required, Validators.email]],
      password: ['', [Validators.required, Validators.minLength(8), Validators.maxLength(72)]],
      confirm: ['', Validators.required],
    },
    { validators: passwordsMatch },
  );
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected invalid(name: 'email' | 'password' | 'confirm'): boolean {
    const c = this.form.controls[name];
    return c.invalid && (c.touched || c.dirty);
  }

  protected mismatch(): boolean {
    return this.form.hasError('mismatch') && this.form.controls.confirm.touched;
  }

  protected submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.error.set(null);
    const { email, password } = this.form.getRawValue();
    this.auth.register(email, password).subscribe({
      next: () => void this.router.navigateByUrl('/'),
      error: (e) => {
        this.error.set(errorMessage(e));
        this.submitting.set(false);
      },
    });
  }
}
