import { Routes } from '@angular/router';
import { adminGuard, authGuard, guestGuard } from './core/guards/auth.guard';

// Every page is lazy-loaded: its code is only downloaded when the user first visits it.
export const routes: Routes = [
  { path: '', pathMatch: 'full', title: 'ScaleCart · Shop smarter', loadComponent: () => import('./features/home/home.page').then((m) => m.HomePage) },

  { path: 'login', canActivate: [guestGuard], title: 'Log in · ScaleCart', loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage) },
  { path: 'register', canActivate: [guestGuard], title: 'Register · ScaleCart', loadComponent: () => import('./features/auth/register.page').then((m) => m.RegisterPage) },

  { path: 'products', title: 'Products · ScaleCart', loadComponent: () => import('./features/products/product-list.page').then((m) => m.ProductListPage) },
  { path: 'products/:id', title: 'Product · ScaleCart', loadComponent: () => import('./features/products/product-detail.page').then((m) => m.ProductDetailPage) },

  { path: 'cart', canActivate: [authGuard], title: 'Cart · ScaleCart', loadComponent: () => import('./features/cart/cart.page').then((m) => m.CartPage) },
  { path: 'checkout', canActivate: [authGuard], title: 'Checkout · ScaleCart', loadComponent: () => import('./features/checkout/checkout.page').then((m) => m.CheckoutPage) },

  { path: 'orders', canActivate: [authGuard], title: 'My orders · ScaleCart', loadComponent: () => import('./features/orders/order-list.page').then((m) => m.OrderListPage) },
  { path: 'orders/:id', canActivate: [authGuard], title: 'Order · ScaleCart', loadComponent: () => import('./features/orders/order-detail.page').then((m) => m.OrderDetailPage) },

  {
    path: 'admin',
    canActivate: [authGuard, adminGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'products' },
      { path: 'products', title: 'Manage products · ScaleCart', loadComponent: () => import('./features/admin/admin-products.page').then((m) => m.AdminProductsPage) },
      { path: 'products/new', title: 'New product · ScaleCart', loadComponent: () => import('./features/admin/product-form.page').then((m) => m.ProductFormPage) },
      { path: 'products/:id/edit', title: 'Edit product · ScaleCart', loadComponent: () => import('./features/admin/product-form.page').then((m) => m.ProductFormPage) },
    ],
  },

  { path: '**', title: 'Not found · ScaleCart', loadComponent: () => import('./features/not-found.page').then((m) => m.NotFoundPage) },
];
