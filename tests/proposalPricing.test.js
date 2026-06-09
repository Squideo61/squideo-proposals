import { describe, it, expect } from 'vitest';
import { computeProposalCheckout } from '../api/_lib/proposalPricing.js';

// Authoritative server-side pricing for Stripe checkout. These lock in that the
// figure is derived from the PROPOSAL's prices and the SIGNED selections — never
// from any client-supplied total — so a tampered checkout `amount` can't slip a
// proposal through for less than it's worth.

const baseProposal = {
  basePrice: 5000,
  vatRate: 0.2,
  videoOptions: [],
  optionalExtras: [
    { id: 'voiceover', price: 125 },
    { id: 'subtitles', price: 125 },
    { id: 'translatedsubs', price: 200, variantsEnabled: true },
  ],
  partnerProgramme: { discountRate: 0.1, extraDiscountPerCredit: 0, maxDiscount: 0.1, standardRatePerMin: 1250 },
};

describe('computeProposalCheckout', () => {
  it('prices a plain full-payment proposal (base + VAT)', () => {
    const r = computeProposalCheckout(baseProposal, { paymentOption: 'full' });
    expect(r.amountGross).toBe(6000); // 5000 * 1.2
    expect(r.isDeposit).toBe(false);
  });

  it('halves the amount for a 50/50 deposit', () => {
    const r = computeProposalCheckout(baseProposal, { paymentOption: '5050' });
    expect(r.amountGross).toBe(3000);
    expect(r.isDeposit).toBe(true);
  });

  it('adds selected extras at the PROPOSAL price, ignoring any tampered price in the signature', () => {
    const sig = {
      paymentOption: 'full',
      selectedExtras: [
        { id: 'voiceover', price: 0.01 }, // attacker-tampered price — must be ignored
        { id: 'subtitles' },
      ],
    };
    const r = computeProposalCheckout(baseProposal, sig);
    // (5000 + 125 + 125) * 1.2 = 6300, NOT priced off the tampered 0.01
    expect(r.amountGross).toBe(6300);
  });

  it('ignores selections that are not in the proposal', () => {
    const sig = { paymentOption: 'full', selectedExtras: [{ id: 'not-a-real-extra', price: 999 }] };
    const r = computeProposalCheckout(baseProposal, sig);
    expect(r.amountGross).toBe(6000);
  });

  it('charges variant extras by quantity', () => {
    const sig = { paymentOption: 'full', selectedExtras: [{ id: 'translatedsubs', quantity: 3 }] };
    const r = computeProposalCheckout(baseProposal, sig);
    // (5000 + 200*3) * 1.2 = 6720
    expect(r.amountGross).toBe(6720);
  });

  it('applies a percentage discount from the proposal (not the signature)', () => {
    const prop = { ...baseProposal, discount: { type: 'percent', value: 10 } };
    const sig = { paymentOption: 'full', discountApplied: { amount: 4999 } }; // tampered — ignored
    const r = computeProposalCheckout(prop, sig);
    // (5000 - 500) * 1.2 = 5400
    expect(r.amountGross).toBe(5400);
  });

  it('uses the selected video option price matched by id', () => {
    const prop = {
      ...baseProposal,
      videoOptions: [
        { id: 'opt_a', label: 'A', price: 3000 },
        { id: 'opt_b', label: 'B', price: 8000 },
      ],
    };
    const sig = { paymentOption: 'full', selectedVideoOption: { id: 'opt_b', label: 'B', price: 1 } };
    const r = computeProposalCheckout(prop, sig);
    expect(r.amountGross).toBe(9600); // 8000 * 1.2, tampered price ignored
  });

  it('prices the partner programme (discounted project + first month) from proposal rates', () => {
    const sig = { paymentOption: 'full', partnerSelected: true, partnerCredits: 1 };
    const r = computeProposalCheckout(baseProposal, sig);
    // project: 5000 * 0.9 = 4500 ex VAT; partner: 1250 * 0.9 * 1 = 1125 ex VAT
    expect(r.projectExVat).toBe(4500);
    expect(r.partnerExVat).toBe(1125);
    expect(r.partnerSelected).toBe(true);
    // due now gross = (4500 + 1125) * 1.2 = 6750
    expect(r.amountGross).toBe(6750);
  });

  it('returns null when there is no proposal to price', () => {
    expect(computeProposalCheckout(null, { paymentOption: 'full' })).toBeNull();
  });
});
