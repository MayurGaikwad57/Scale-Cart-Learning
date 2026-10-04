// Types mirroring the backend API responses. Money is always integer cents.

export type Role = 'CUSTOMER' | 'ADMIN';

export interface User {
  id: string;
  email: string;
  role: Role;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  category: string;
  active: boolean;
  createdAt: string;
  stock: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type ProductSort = 'newest' | 'price_asc' | 'price_desc' | 'name';

export interface ProductQuery {
  page: number;
  pageSize: number;
  q?: string;
  category?: string;
  minPrice?: number; // cents
  maxPrice?: number; // cents
  sort: ProductSort;
  includeInactive?: boolean;
}

export interface CartItem {
  id: string;
  productId: string;
  name: string;
  sku: string;
  category: string;
  priceCents: number;
  quantity: number;
  lineTotalCents: number;
  stock: number;
  purchasable: boolean;
}

export interface Cart {
  id: string;
  items: CartItem[];
  itemCount: number;
  totalCents: number;
}

export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED';
export type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';
export type PaymentMethod = 'TEST_CARD_SUCCESS' | 'TEST_CARD_DECLINE';

export interface OrderItem {
  productId: string;
  name: string;
  sku: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface Order {
  id: string;
  status: OrderStatus;
  totalCents: number;
  createdAt: string;
  items: OrderItem[];
  payment: { status: PaymentStatus; amountCents: number } | null;
}

export interface AuthResponse {
  user: User;
  token: string;
}
