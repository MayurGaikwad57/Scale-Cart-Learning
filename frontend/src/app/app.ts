import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { Navbar } from './shared/components/navbar';
import { ToastContainer } from './shared/components/toast-container';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, Navbar, ToastContainer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-navbar />
    <main class="container py-4 py-md-5">
      <router-outlet />
    </main>
    <footer class="sc-footer">
      <div class="container d-flex flex-wrap justify-content-between gap-3">
        <div>
          <div class="fw-bold text-white mb-1">ScaleCart</div>
          A learning project: a modular monolith on its way to microservices.
        </div>
        <div class="d-flex gap-4 align-items-start">
          <a routerLink="/products">Shop</a>
          <a routerLink="/orders">Orders</a>
          <a routerLink="/cart">Cart</a>
        </div>
      </div>
    </footer>
    <app-toast-container />
  `,
})
export class App {}
