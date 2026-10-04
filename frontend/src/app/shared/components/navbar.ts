import { ChangeDetectionStrategy, Component, ElementRef, HostListener, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { CartService } from '../../core/services/cart.service';
import { Icon } from './icon';

@Component({
  selector: 'app-navbar',
  imports: [RouterLink, RouterLinkActive, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="sc-nav">
      <div class="container sc-nav-inner">
        <a class="sc-brand" routerLink="/" (click)="closeAll()" aria-label="ScaleCart home">
          <span class="sc-logo"><app-icon name="bag" [size]="19" /></span>
          ScaleCart
        </a>

        <nav class="sc-nav-links" aria-label="Main">
          <a class="sc-nav-link" routerLink="/products" routerLinkActive="active">Shop</a>
          @if (auth.isLoggedIn()) {
            <a class="sc-nav-link" routerLink="/orders" routerLinkActive="active">My orders</a>
          }
          @if (auth.isAdmin()) {
            <a class="sc-nav-link" routerLink="/admin" routerLinkActive="active">Admin</a>
          }
        </nav>

        <div class="sc-nav-spacer"></div>

        @if (auth.user(); as user) {
          <a class="sc-iconbtn" routerLink="/cart" aria-label="Cart" (click)="closeAll()">
            <app-icon name="cart" [size]="22" />
            @if (cart.count() > 0) {
              <span class="sc-cart-badge" data-testid="cart-count">{{ cart.count() }}</span>
            }
          </a>
          <!-- Local component state: is the account menu open? Only this component cares, so a plain signal. -->
          <div class="sc-menu-wrap ms-1">
            <button class="sc-avatar" type="button" aria-haspopup="menu" [attr.aria-expanded]="menuOpen()" aria-label="Account menu"
              (click)="menuOpen.set(!menuOpen()); mobileOpen.set(false)">{{ user.email.charAt(0) }}</button>
            @if (menuOpen()) {
              <div class="sc-menu" role="menu">
                <div class="sc-menu-head">
                  <div class="fw-semibold text-truncate">{{ user.email }}</div>
                  <span class="sc-pill no-dot mt-1" [class]="auth.isAdmin() ? 'sc-pill-primary' : 'sc-pill-neutral'">{{ auth.isAdmin() ? 'Administrator' : 'Customer' }}</span>
                </div>
                <a class="sc-menu-item" role="menuitem" routerLink="/orders" (click)="closeAll()"><app-icon name="package" [size]="18" /> My orders</a>
                <a class="sc-menu-item" role="menuitem" routerLink="/cart" (click)="closeAll()"><app-icon name="cart" [size]="18" /> Cart</a>
                @if (auth.isAdmin()) {
                  <a class="sc-menu-item" role="menuitem" routerLink="/admin" (click)="closeAll()"><app-icon name="grid" [size]="18" /> Manage products</a>
                }
                <button class="sc-menu-item" role="menuitem" type="button" (click)="logout()"><app-icon name="logout" [size]="18" /> Log out</button>
              </div>
            }
          </div>
        } @else {
          <a class="sc-btn sc-btn-ghost sc-btn-sm d-none d-sm-inline-flex" routerLink="/login">Log in</a>
          <a class="sc-btn sc-btn-primary sc-btn-sm" routerLink="/register">Sign up</a>
        }

        <button class="sc-iconbtn d-md-none ms-1" type="button" aria-label="Toggle menu" [attr.aria-expanded]="mobileOpen()"
          (click)="mobileOpen.set(!mobileOpen()); menuOpen.set(false)">
          <app-icon [name]="mobileOpen() ? 'x' : 'layers'" [size]="22" />
        </button>
      </div>

      @if (mobileOpen()) {
        <nav class="sc-mobile-nav d-md-none" aria-label="Mobile">
          <a routerLink="/products" routerLinkActive="active" (click)="closeAll()">Shop</a>
          @if (auth.isLoggedIn()) { <a routerLink="/orders" routerLinkActive="active" (click)="closeAll()">My orders</a> }
          @if (auth.isAdmin()) { <a routerLink="/admin" routerLinkActive="active" (click)="closeAll()">Admin</a> }
          @if (!auth.isLoggedIn()) { <a routerLink="/login" (click)="closeAll()">Log in</a> }
        </nav>
      }
    </header>
  `,
})
export class Navbar {
  protected readonly auth = inject(AuthService);
  protected readonly cart = inject(CartService);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly menuOpen = signal(false);
  protected readonly mobileOpen = signal(false);

  protected closeAll(): void {
    this.menuOpen.set(false);
    this.mobileOpen.set(false);
  }

  protected logout(): void {
    this.auth.logout();
    this.closeAll();
    void this.router.navigate(['/login']);
  }

  // Click anywhere outside the navbar, or press Escape, closes the open menu.
  @HostListener('document:click', ['$event'])
  protected onDocumentClick(event: Event): void {
    if (!this.host.nativeElement.contains(event.target as Node)) this.closeAll();
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.closeAll();
  }
}
