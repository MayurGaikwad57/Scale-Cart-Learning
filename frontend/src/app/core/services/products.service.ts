import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { API_URL } from '../config';
import { Page, Product, ProductQuery } from '../models';

export interface ProductInput {
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  category: string;
  active: boolean;
  stock?: number;
}

@Injectable({ providedIn: 'root' })
export class ProductsService {
  private readonly http = inject(HttpClient);

  list(query: ProductQuery): Observable<Page<Product>> {
    let params = new HttpParams().set('page', query.page).set('pageSize', query.pageSize).set('sort', query.sort);
    if (query.q) params = params.set('q', query.q);
    if (query.category) params = params.set('category', query.category);
    if (query.minPrice !== undefined) params = params.set('minPrice', query.minPrice);
    if (query.maxPrice !== undefined) params = params.set('maxPrice', query.maxPrice);
    if (query.includeInactive) params = params.set('includeInactive', 'true');
    return this.http.get<Page<Product>>(`${API_URL}/products`, { params });
  }

  get(id: string): Observable<Product> {
    return this.http.get<Product>(`${API_URL}/products/${id}`);
  }

  categories(): Observable<string[]> {
    return this.http.get<string[]>(`${API_URL}/products/categories`);
  }

  create(input: ProductInput): Observable<Product> {
    return this.http.post<Product>(`${API_URL}/products`, input);
  }

  update(id: string, input: Partial<Omit<ProductInput, 'stock'>>): Observable<Product> {
    return this.http.put<Product>(`${API_URL}/products/${id}`, input);
  }

  remove(id: string): Observable<void> {
    return this.http.delete<void>(`${API_URL}/products/${id}`);
  }

  setStock(productId: string, available: number): Observable<{ productId: string; available: number; reserved: number }> {
    return this.http.post<{ productId: string; available: number; reserved: number }>(`${API_URL}/inventory`, {
      productId,
      available,
    });
  }
}
