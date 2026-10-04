import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Icon } from '../../shared/components/icon';
import { errorMessage } from '../../core/http-error';
import { ProductInput, ProductsService } from '../../core/services/products.service';
import { ToastService } from '../../core/services/toast.service';

// One form for both "new" (no id) and "edit" (id from the route).
@Component({
  selector: 'app-product-form-page',
  imports: [ReactiveFormsModule, RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a routerLink="/admin/products" class="sc-btn sc-btn-ghost sc-btn-sm mb-3"><app-icon name="arrowLeft" [size]="16" /> All products</a>
    <div class="mb-4">
      <div class="sc-eyebrow">Admin</div>
      <h1 class="sc-page-title">{{ id() ? 'Edit product' : 'New product' }}</h1>
    </div>

    @if (error()) {
      <div class="sc-alert sc-alert-danger mb-3" role="alert"><app-icon name="alert" [size]="20" /><span>{{ error() }}</span></div>
    }

    <form [formGroup]="form" (ngSubmit)="save()" class="sc-card sc-card-pad" style="max-width: 860px" novalidate>
      <div class="row g-3">
        <div class="col-md-4">
          <label class="form-label" for="sku">SKU</label>
          <input id="sku" class="form-control" formControlName="sku" placeholder="e.g. ELEC-010" [class.is-invalid]="invalid('sku')" />
          <div class="invalid-feedback">Required (max 64 characters).</div>
        </div>
        <div class="col-md-8">
          <label class="form-label" for="name">Name</label>
          <input id="name" class="form-control" formControlName="name" placeholder="Product name" [class.is-invalid]="invalid('name')" />
          <div class="invalid-feedback">Required (max 200 characters).</div>
        </div>
        <div class="col-12">
          <label class="form-label" for="description">Description</label>
          <textarea id="description" rows="4" class="form-control" formControlName="description" placeholder="What makes it great?"></textarea>
        </div>
        <div class="col-md-4">
          <label class="form-label" for="category">Category</label>
          <input id="category" class="form-control" formControlName="category" list="cats" placeholder="Pick or type" [class.is-invalid]="invalid('category')" />
          <datalist id="cats"><option value="Electronics"></option><option value="Books"></option><option value="Home"></option><option value="Fashion"></option></datalist>
          <div class="invalid-feedback">Required.</div>
        </div>
        <div class="col-md-4">
          <label class="form-label" for="price">Price (₹)</label>
          <input id="price" type="number" step="0.01" min="0" class="form-control" formControlName="priceRupees" [class.is-invalid]="invalid('priceRupees')" />
          <div class="invalid-feedback">Enter a price of 0 or more.</div>
        </div>
        @if (!id()) {
          <div class="col-md-4">
            <label class="form-label" for="stock">Initial stock</label>
            <input id="stock" type="number" min="0" class="form-control" formControlName="stock" [class.is-invalid]="invalid('stock')" />
            <div class="invalid-feedback">Whole number, 0 or more.</div>
          </div>
        } @else {
          <div class="col-md-4 d-flex align-items-end"><span class="small sc-muted">Change stock from the product list.</span></div>
        }
        <div class="col-12">
          <div class="form-check form-switch">
            <input id="active" type="checkbox" role="switch" class="form-check-input" formControlName="active" />
            <label for="active" class="form-check-label">Visible in the shop</label>
          </div>
        </div>
      </div>
      <div class="d-flex gap-2 mt-4 pt-3" style="border-top: 1px solid var(--sc-line)">
        <button class="sc-btn sc-btn-primary" type="submit" [disabled]="saving()">
          @if (saving()) { <span class="sc-spinner"></span> Saving… } @else { <app-icon name="check" [size]="18" /> Save product }
        </button>
        <a routerLink="/admin/products" class="sc-btn">Cancel</a>
      </div>
    </form>
  `,
})
export class ProductFormPage {
  private readonly products = inject(ProductsService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  readonly id = input<string | undefined>(); // present on /admin/products/:id/edit

  protected readonly form = inject(NonNullableFormBuilder).group({
    sku: ['', [Validators.required, Validators.maxLength(64)]],
    name: ['', [Validators.required, Validators.maxLength(200)]],
    description: [''],
    category: ['', Validators.required],
    priceRupees: [0, [Validators.required, Validators.min(0)]],
    stock: [0, [Validators.required, Validators.min(0), Validators.pattern(/^\d+$/)]],
    active: [true],
  });
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    // effect(): when we are in edit mode, load the product and fill the form.
    effect(() => {
      const id = this.id();
      if (!id) return;
      this.products.get(id).subscribe({
        next: (p) =>
          this.form.patchValue({
            sku: p.sku,
            name: p.name,
            description: p.description,
            category: p.category,
            priceRupees: p.priceCents / 100,
            active: p.active,
          }),
        error: (e) => this.error.set(errorMessage(e)),
      });
    });
  }

  protected invalid(name: string): boolean {
    const c = this.form.get(name);
    return !!c && c.invalid && (c.touched || c.dirty);
  }

  protected save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const body: ProductInput = {
      sku: v.sku.trim(),
      name: v.name.trim(),
      description: v.description.trim(),
      category: v.category.trim(),
      priceCents: Math.round(v.priceRupees * 100),
      active: v.active,
    };
    this.saving.set(true);
    this.error.set(null);
    const id = this.id();
    const request = id ? this.products.update(id, body) : this.products.create({ ...body, stock: v.stock });
    request.subscribe({
      next: () => {
        this.toast.show(id ? 'Product updated' : 'Product created');
        void this.router.navigate(['/admin/products']);
      },
      error: (e) => {
        this.error.set(errorMessage(e));
        this.saving.set(false);
      },
    });
  }
}
