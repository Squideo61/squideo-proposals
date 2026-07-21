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

  // Per-minute extras: `price` covers the first minute, then perExtraMinute is
  // added for each additional minute of content the proposal covers.
  const perMinProposal = {
    ...baseProposal,
    partnerProgramme: { ...baseProposal.partnerProgramme, quotedMinutes: 8 },
    optionalExtras: [
      { id: 'voiceover', price: 125, priceModel: 'perExtraMinute', perExtraMinute: 30 },
      { id: 'translatedsubs', price: 200, priceModel: 'perExtraMinute', perExtraMinute: 30, variantsEnabled: true },
      { id: 'shortedit', price: 300, perVersion: true },
      { id: 'assetpack', price: 500 },
    ],
  };

  it('scales a per-minute extra by the minutes the proposal covers', () => {
    const sig = { paymentOption: 'full', selectedExtras: [{ id: 'voiceover' }] };
    const r = computeProposalCheckout(perMinProposal, sig);
    // voiceover on 8 min = 125 + 7*30 = 335; (5000 + 335) * 1.2 = 6402
    expect(r.amountGross).toBe(6402);
  });

  it('scales a per-minute extra and then multiplies by quantity', () => {
    const sig = { paymentOption: 'full', selectedExtras: [{ id: 'translatedsubs', quantity: 3 }] };
    const r = computeProposalCheckout(perMinProposal, sig);
    // unit = 200 + 7*30 = 410; x3 = 1230; (5000 + 1230) * 1.2 = 7476
    expect(r.amountGross).toBe(7476);
  });

  it('charges perVersion extras by quantity without scaling by minutes', () => {
    const sig = { paymentOption: 'full', selectedExtras: [{ id: 'shortedit', quantity: 2 }] };
    const r = computeProposalCheckout(perMinProposal, sig);
    // 300 * 2 = 600 regardless of the 8 minutes; (5000 + 600) * 1.2 = 6720
    expect(r.amountGross).toBe(6720);
  });

  it('leaves fixed extras alone however long the content is', () => {
    const sig = { paymentOption: 'full', selectedExtras: [{ id: 'assetpack', quantity: 5 }] };
    const r = computeProposalCheckout(perMinProposal, sig);
    // fixed and not perVersion → quantity ignored; (5000 + 500) * 1.2 = 6600
    expect(r.amountGross).toBe(6600);
  });

  it('treats a proposal with no minutes set as a single minute', () => {
    const noMins = { ...perMinProposal, partnerProgramme: { ...baseProposal.partnerProgramme } };
    const sig = { paymentOption: 'full', selectedExtras: [{ id: 'voiceover' }] };
    const r = computeProposalCheckout(noMins, sig);
    // no scaling → base 125; (5000 + 125) * 1.2 = 6150
    expect(r.amountGross).toBe(6150);
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

  it('one-off Content Credit: full payment bills project + credit block once', () => {
    const prop = {
      ...baseProposal,
      partnerProgramme: { ...baseProposal.partnerProgramme, mode: 'oneoff', extraDiscountPerCredit: 0.03, maxDiscount: 0.3 },
    };
    const sig = { paymentOption: 'full', partnerSelected: true, partnerCredits: 4 };
    const r = computeProposalCheckout(prop, sig);
    // tier for 4 credits: 0.1 + 3*0.03 = 0.19; project 5000*0.81 = 4050;
    // credit 1250*0.81*4 = 4050; gross (4050+4050)*1.2 = 9720
    expect(r.projectExVat).toBe(4050);
    expect(r.partnerExVat).toBe(4050);
    expect(r.isDeposit).toBe(false);
    expect(r.amountGross).toBe(9720);
  });

  it('one-off Content Credit: 50/50 split halves the combined project + credit (allowed here, unlike subscription)', () => {
    const prop = {
      ...baseProposal,
      partnerProgramme: { ...baseProposal.partnerProgramme, mode: 'oneoff' },
    };
    const sig = { paymentOption: '5050', partnerSelected: true, partnerCredits: 1 };
    const r = computeProposalCheckout(prop, sig);
    // project 5000*0.9=4500, credit 1250*0.9=1125; combined gross (5625)*1.2=6750; half=3375
    expect(r.isDeposit).toBe(true);
    expect(r.amountGross).toBe(3375);
  });

  // Credit-only proposals quote the deliverable in minutes at the standard rate.
  // Only the EXTRA minutes the client adds on the proposal get the tier discount —
  // the quoted work is never discounted, unlike the regular partner path above.
  const creditOnlyProposal = {
    ...baseProposal,
    partnerProgramme: {
      ...baseProposal.partnerProgramme,
      mode: 'oneoff',
      creditOnly: true,
      quotedMinutes: 4,
      extraDiscountPerCredit: 0.03,
      maxDiscount: 0.3,
    },
  };

  it('credit-only: quoted project stays at full price, only added minutes are discounted', () => {
    const sig = { paymentOption: 'full', partnerSelected: true, partnerCredits: 4 };
    const r = computeProposalCheckout(creditOnlyProposal, sig);
    // tier for 4 added credits: 0.1 + 3*0.03 = 0.19
    expect(r.projectExVat).toBe(5000);          // NOT 4050 — quoted work undiscounted
    expect(r.partnerExVat).toBe(4050);          // 1250 * 0.81 * 4, added minutes discounted
    expect(r.amountGross).toBe(10860);          // (5000 + 4050) * 1.2
  });

  it('credit-only: no credit added means no discount anywhere', () => {
    const r = computeProposalCheckout(creditOnlyProposal, { paymentOption: 'full' });
    expect(r.projectExVat).toBe(5000);
    expect(r.amountGross).toBe(6000);           // 5000 * 1.2
  });

  it('credit-only: 50/50 still halves the combined project + added credit', () => {
    const sig = { paymentOption: '5050', partnerSelected: true, partnerCredits: 1 };
    const r = computeProposalCheckout(creditOnlyProposal, sig);
    // project 5000 undiscounted, credit 1250*0.9=1125; (6125)*1.2=7350; half=3675
    expect(r.isDeposit).toBe(true);
    expect(r.amountGross).toBe(3675);
  });

  it('subscription partner still forces full payment (50/50 ignored → full combined)', () => {
    const sig = { paymentOption: '5050', partnerSelected: true, partnerCredits: 1 };
    const r = computeProposalCheckout(baseProposal, sig);
    expect(r.isDeposit).toBe(false);
    expect(r.amountGross).toBe(6750); // (4500 + 1125) * 1.2, not halved
  });

  it('returns null when there is no proposal to price', () => {
    expect(computeProposalCheckout(null, { paymentOption: 'full' })).toBeNull();
  });
});
