import { Pipe, PipeTransform } from '@angular/core';

const formatter = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

/** Backend money is integer cents (paise): 599900 -> "₹5,999.00". Usage: {{ priceCents | money }} */
@Pipe({ name: 'money' })
export class MoneyPipe implements PipeTransform {
  transform(cents: number | null | undefined): string {
    return formatter.format((cents ?? 0) / 100);
  }
}
