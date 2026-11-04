import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { API_URL } from '../config';
import { PaymentsOverview, ServicesOverview } from '../models';

/** Admin > Services (M6): the gateway's view of every service, and the payment service's numbers. */
@Injectable({ providedIn: 'root' })
export class ServicesService {
  private readonly http = inject(HttpClient);

  overview(): Observable<ServicesOverview> {
    return this.http.get<ServicesOverview>(`${API_URL}/admin/services`);
  }
  payments(): Observable<PaymentsOverview> {
    return this.http.get<PaymentsOverview>(`${API_URL}/admin/payments`);
  }
}
