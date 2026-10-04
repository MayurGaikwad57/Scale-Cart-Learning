import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { CartService } from '../../core/services/cart.service';

@Component({
  selector: 'app-navbar',
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="navbar navbar-expand-lg navbar-dark bg-dark sticky-top">
      <div class="container">
        <a class="navbar-brand fw-bold" routerLink="/">🛒 ScaleCart</a>
        <!-- Local component state: is the mobile menu open? Nobody else cares, so a plain signal here. -->
        <button class="navbar-toggler" type="button" aria-label="Toggle menu" (click)="menuOpen.set(!menuOpen())">
          <span class="navbar-toggler-icon"></span>
        </button>
        <div class="navbar-collapse collapse" [class.show]="menuOpen()">
          <ul class="navbar-nav me-auto">
            <li class="nav-item">
              <a class="nav-link" routerLink="/products" routerLinkActive="active" (click)="menuOpen.set(false)">Products</a>
            </li>
            @if (auth.isLoggedIn()) {
              <li class="nav-item">
                <a class="nav-link" routerLink="/orders" routerLinkActive="active" (click)="menuOpen.set(false)">My orders</a>
              </li>
            }
            @if (auth.isAdmin()) {
              <li class="nav-item">
                <a class="nav-link" routerLink="/admin/products" routerLinkActive="active" (click)="menuOpen.set(false)">Admin</a>
              </li>
            }
          </ul>
          <ul class="navbar-nav align-items-lg-center gap-lg-2">
            @if (auth.user(); as user) {
              <li class="nav-item">
                <a class="nav-link position-relative" routerLink="/cart" routerLinkActive="active" (click)="menuOpen.set(false)">
                  Cart
                  @if (cart.count() > 0) {
                    <span class="badge rounded-pill text-bg-warning ms-1" data-testid="cart-count">{{ cart.count() }}</span>
                  }
                </a>
              </li>
              <li class="nav-item"><span class="navbar-text small">{{ user.email }}@if (auth.isAdmin()) { <span class="badge text-bg-info ms-1">admin</span> }</span></li>
              <li class="nav-item"><button class="btn btn-outline-light btn-sm" (click)="logout()">Logout</button></li>
            } @else {
              <li class="nav-item"><a class="nav-link" routerLink="/login" (click)="menuOpen.set(false)">Login</a></li>
              <li class="nav-item"><a class="btn btn-warning btn-sm" routerLink="/register" (click)="menuOpen.set(false)">Register</a></li>
            }
          </ul>
        </div>
      </div>
    </nav>
  `,
})
export class Navbar {
  protected readonly auth = inject(AuthService);
  protected readonly cart = inject(CartService);
  private readonly router = inject(Router);
  protected readonly menuOpen = signal(false);

  protected logout(): void {
    this.auth.logout();
    this.menuOpen.set(false);
    void this.router.navigate(['/login']);
  }
}
