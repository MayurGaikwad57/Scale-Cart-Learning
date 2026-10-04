import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from '../shared/components/icon';

@Component({
  selector: 'app-not-found-page',
  imports: [RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sc-card sc-empty" style="max-width: 560px; margin: 3rem auto">
      <div class="sc-empty-icon"><app-icon name="search" [size]="30" /></div>
      <div class="sc-eyebrow mb-1">Error 404</div>
      <h1 class="h3">This page doesn't exist</h1>
      <p class="sc-muted">The link may be broken or the page may have moved.</p>
      <a routerLink="/products" class="sc-btn sc-btn-primary">Go to the shop <app-icon name="arrowRight" [size]="18" /></a>
    </div>
  `,
})
export class NotFoundPage {}
