import { describe, it, expect } from 'vitest';
import { videoCreditDiscount, videoCreditQuote } from '../api/_lib/videoCreditPricing.js';

// The portal "Video Credit" purchase price is the SERVER-SIDE authority for the
// Stripe amount, so these lock in the standard one-off Content Credit discount
// tiers (10% base, +2.5% per extra minute, capped at 20%) and the money math.
// The portal mirrors this for display only.

describe('videoCreditDiscount ladder', () => {
  it('climbs 2.5% per extra minute from a 10% base', () => {
    expect(videoCreditDiscount(1)).toBeCloseTo(0.10, 10);
    expect(videoCreditDiscount(2)).toBeCloseTo(0.125, 10);
    expect(videoCreditDiscount(3)).toBeCloseTo(0.15, 10);
  });

  it('caps at 20% (reached at 5 minutes) and never exceeds it', () => {
    expect(videoCreditDiscount(5)).toBeCloseTo(0.20, 10);
    expect(videoCreditDiscount(20)).toBeCloseTo(0.20, 10);
  });

  it('floors sub-1 / bad input at the 1-minute tier', () => {
    expect(videoCreditDiscount(0)).toBeCloseTo(0.10, 10);
    expect(videoCreditDiscount(-5)).toBeCloseTo(0.10, 10);
  });
});

describe('videoCreditQuote money math', () => {
  it('prices 1 minute at the base discount + VAT', () => {
    const q = videoCreditQuote(1, 1000);
    expect(q.discount).toBeCloseTo(0.10, 10);
    expect(q.unitExVat).toBeCloseTo(900, 6);         // 1000 * 0.90
    expect(q.subtotalExVat).toBeCloseTo(900, 6);
    expect(q.vat).toBeCloseTo(180, 6);               // * 0.20
    expect(q.totalIncVat).toBeCloseTo(1080, 6);
  });

  it('applies the deeper discount to the whole block at higher volumes', () => {
    const q = videoCreditQuote(3, 1000);
    expect(q.discount).toBeCloseTo(0.15, 10);
    expect(q.subtotalExVat).toBeCloseTo(1000 * 0.85 * 3, 6); // 2550
    expect(q.totalIncVat).toBeCloseTo(2550 * 1.2, 6);        // 3060
  });

  it('honours a custom per-minute rate', () => {
    const q = videoCreditQuote(2, 1250);
    expect(q.subtotalExVat).toBeCloseTo(1250 * 0.875 * 2, 6); // 12.5% off, 2187.5
  });
});
