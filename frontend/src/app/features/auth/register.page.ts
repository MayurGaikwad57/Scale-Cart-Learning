import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { AbstractControl, NonNullableFormBuilder, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { errorMessage } from '../../core/http-error';

// Group-level validator: runs when either password field changes.
const passwordsMatch = (group: AbstractControl): ValidationErrors | null =>
  group.get('password')?.value === group.get('confirm')?.value ? null : { mismatch: true };

@Component({
  selector: 'app-register-page',
  imports: [ReactiveFormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="row justify-content-center">
      <div class="col-md-6 col-lg-5">
        <div class="card shadow-sm">
          <div class="card-body p-4">
            <h1 class="h4 mb-3">Create account</h1>
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
                <input id="password" type="password" class="form-control" formControlName="password" autocomplete="new-password"
                  [class.is-invalid]="invalid('password')" />
                <div class="form-text">8 to 72 characters.</div>
                @if (invalid('password')) {
                  <div class="invalid-feedback">Password must be 8 to 72 characters.</div>
                }
              </div>
              <div class="mb-3">
                <label class="form-label" for="confirm">Confirm password</label>
                <input id="confirm" type="password" class="form-control" formControlName="confirm" autocomplete="new-password"
                  [class.is-invalid]="invalid('confirm') || mismatch()" />
                @if (mismatch()) {
                  <div class="invalid-feedback">Passwords do not match.</div>
                }
              </div>
              <button class="btn btn-primary w-100" type="submit" [disabled]="submitting()">
                {{ submitting() ? 'Creating account…' : 'Register' }}
              </button>
            </form>
            <p class="mt-3 mb-0 small">Already registered? <a routerLink="/login">Log in</a></p>
          </div>
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
