import { describe, expect, it } from 'vitest';
import { MoneyPipe } from './money.pipe';

describe('MoneyPipe', () => {
  const pipe = new MoneyPipe();

  it('converts cents to rupees with Indian grouping', () => {
    expect(pipe.transform(599900).replace(/\s/g, '')).toBe('₹5,999.00');
    expect(pipe.transform(50).replace(/\s/g, '')).toBe('₹0.50');
  });

  it('treats null/undefined as zero', () => {
    expect(pipe.transform(null).replace(/\s/g, '')).toBe('₹0.00');
    expect(pipe.transform(undefined).replace(/\s/g, '')).toBe('₹0.00');
  });
});
