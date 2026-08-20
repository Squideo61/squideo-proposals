import { describe, it, expect } from 'vitest';

// The over-payment guard in POST /api/crm/payments. Mirrors the rule inline in
// api/_lib/crm/payments.js so the boundary behaviour is pinned: a deal can't
// silently pass its signed total (which is how a 50% deposit came to read as
// "paid in full"), but extras and genuine overpayments stay recordable.
const wouldExceed = (bal, amount) =>
  bal.known && bal.paid + amount > bal.committed + 0.005;

describe('payment over-payment guard', () => {
  // The real case: £1,200 signed, £600 deposit invoice already marked paid,
  // then £1,200 recorded as a "full" payment on top → £1,800 booked.
  const whoDoILove = { known: true, committed: 1200, paid: 600 };

  it('catches the full project value recorded when only the deposit landed', () => {
    expect(wouldExceed(whoDoILove, 1200)).toBe(true);
  });

  it('allows the genuine outstanding balance', () => {
    expect(wouldExceed(whoDoILove, 600)).toBe(false);
  });

  it('allows a first deposit on an untouched deal', () => {
    expect(wouldExceed({ known: true, committed: 1200, paid: 0 }, 600)).toBe(false);
  });

  it('allows settling exactly to the signed total', () => {
    expect(wouldExceed({ known: true, committed: 1200, paid: 1200 }, 0)).toBe(false);
  });

  it('catches a payment on an already fully-settled deal', () => {
    expect(wouldExceed({ known: true, committed: 1200, paid: 1200 }, 0.5)).toBe(true);
  });

  it('tolerates rounding rather than nagging over a penny', () => {
    expect(wouldExceed({ known: true, committed: 1200, paid: 1199.999 }, 0.001)).toBe(false);
  });

  it('stays out of the way when the deal has no signed total to compare against', () => {
    expect(wouldExceed({ known: false, committed: 0, paid: 0 }, 5000)).toBe(false);
  });
});
