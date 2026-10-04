import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-not-found-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="text-center py-5">
      <h1 class="display-5">404</h1>
      <p class="text-muted">That page does not exist.</p>
      <a routerLink="/products" class="btn btn-primary">Go to products</a>
    </div>
  `,
})
export class NotFoundPage {}
