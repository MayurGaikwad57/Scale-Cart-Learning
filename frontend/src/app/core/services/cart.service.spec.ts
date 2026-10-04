import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../auth/auth.service';
import { API_URL } from '../config';
import { Cart, CartItem } from '../models';
import { CartService } from './cart.service';

const item = (over: Partial<CartItem>): CartItem => ({
  id: 'i1', productId: 'p1', name: 'Thing', sku: 'S', category: 'Home',
  priceCents: 1000, quantity: 1, lineTotalCents: 1000, stock: 10, purchasable: true, ...over,
});
const cartOf = (items: CartItem[]): Cart => ({ id: 'c', items, itemCount: 0, totalCents: 0 });

describe('CartService (signals)', () => {
  let cart: CartService;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    cart = TestBed.inject(CartService);
    http = TestBed.inject(HttpTestingController);
  });

  it('derives count, total and warnings from the items', () => {
    cart.add('p1', 2).subscribe();
    http.expectOne(`${API_URL}/cart/items`).flush(
      cartOf([item({ quantity: 2, lineTotalCents: 2000 }), item({ id: 'i2', productId: 'p2', quantity: 1, lineTotalCents: 500, purchasable: false })]),
    );
    expect(cart.count()).toBe(3);
    expect(cart.totalCents()).toBe(2500);
    expect(cart.hasUnavailableItems()).toBe(true);
  });

  it('is empty by default and not loaded while logged out', () => {
    TestBed.tick(); // run the effect
    http.expectNone(`${API_URL}/cart`);
    expect(cart.count()).toBe(0);
  });

  it('loads the cart when a user logs in and clears it on logout (effect)', () => {
    const auth = TestBed.inject(AuthService);
    http.expectNone(`${API_URL}/cart`);

    localStorage.setItem('scalecart.token', 't');
    localStorage.setItem('scalecart.user', JSON.stringify({ id: 'u', email: 'a@b.c', role: 'CUSTOMER' }));
    // Simulate login through the real service so the effect sees the signal change.
    auth.login('a@b.c', 'pw').subscribe();
    http.expectOne(`${API_URL}/auth/login`).flush({ user: { id: 'u', email: 'a@b.c', role: 'CUSTOMER' }, token: 't' });
    TestBed.tick();
    http.expectOne(`${API_URL}/cart`).flush(cartOf([item({ quantity: 4, lineTotalCents: 4000 })]));
    expect(cart.count()).toBe(4);

    auth.logout();
    TestBed.tick();
    expect(cart.count()).toBe(0);
  });
});
