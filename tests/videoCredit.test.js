import { describe, it, expect } from 'vitest';
import { videoCreditDiscount, videoCreditQuote } from '../api/_lib/videoCreditPricing.js';

// The portal "Video Credit" purchase price is the SERVER-SIDE authority for the
// Stripe amount, so these lock in the Content Credit one-off ladder (15% base,
// +3% per extra minute, capped at 30%) and the money math. The portal mirrors
// this for display only.

describe('videoCreditDiscount ladder', () => {
  it('climbs 3% per extra minute from a 15% base', () => {
    expect(videoCreditDiscount(1)).toBeCloseTo(0.15, 10);
    expect(videoCreditDiscount(2)).toBeCloseTo(0.18, 10);
    expect(videoCreditDiscount(3)).toBeCloseTo(0.21, 10);
  });

  it('caps at 30% (reached at 6 minutes) and never exceeds it', () => {
    expect(videoCreditDiscount(6)).toBeCloseTo(0.30, 10);
    expect(videoCreditDiscount(20)).toBeCloseTo(0.30, 10);
  });

  it('floors sub-1 / bad input at the 1-minute tier', () => {
    expect(videoCreditDiscount(0)).toBeCloseTo(0.15, 10);
    expect(videoCreditDiscount(-5)).toBeCloseTo(0.15, 10);
  });
});

describe('videoCreditQuote money math', () => {
  it('prices 1 minute at the base discount + VAT', () => {
    const q = videoCreditQuote(1, 1250);
    expect(q.discount).toBeCloseTo(0.15, 10);
    expect(q.unitExVat).toBeCloseTo(1062.5, 6);      // 1250 * 0.85
    expect(q.subtotalExVat).toBeCloseTo(1062.5, 6);
    expect(q.vat).toBeCloseTo(212.5, 6);             // * 0.20
    expect(q.totalIncVat).toBeCloseTo(1275, 6);
  });

  it('applies the deeper discount to the whole block at higher volumes', () => {
    const q = videoCreditQuote(3, 1250);
    expect(q.discount).toBeCloseTo(0.21, 10);
    expect(q.subtotalExVat).toBeCloseTo(1250 * 0.79 * 3, 6); // 2962.5
    expect(q.totalIncVat).toBeCloseTo(2962.5 * 1.2, 6);      // 3555
  });

  it('honours a custom per-minute rate', () => {
    const q = videoCreditQuote(2, 1000);
    expect(q.subtotalExVat).toBeCloseTo(1000 * 0.82 * 2, 6); // 18% off, 1640
  });
});
