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

  // Proposals deep-copy optionalExtras at creation, so anything made before
  // per-length pricing existed has extras with NO priceModel. Those must still
  // scale, via the shared catalogue — otherwise every in-flight proposal would
  // quietly charge the flat 1-minute price.
  const legacyProposal = {
    ...baseProposal,
    partnerProgramme: { ...baseProposal.partnerProgramme, quotedMinutes: 8 },
    optionalExtras: [
      { id: 'voiceover', label: 'Professional human voiceover artist', price: 125 },
      { id: 'portrait', label: 'Mobile-friendly 9:16 portrait version', price: 400 },
      { id: 'shortedit', label: 'Short edit', price: 300 },
      { id: 'custom_thing', label: 'Something bespoke', price: 90 },
    ],
  };

  it('scales legacy extras that declare no pricing model, via the catalogue', () => {
    const sig = { paymentOption: 'full', selectedExtras: [{ id: 'voiceover' }, { id: 'portrait' }] };
    const r = computeProposalCheckout(legacyProposal, sig);
    // voiceover 125 + 7*30 = 335; portrait 400 + 7*300 = 2500
    // (5000 + 335 + 2500) * 1.2 = 9402
    expect(r.amountGross).toBe(9402);
  });

  it('honours a legacy perVersion extra from the catalogue', () => {
    const sig = { paymentOption: 'full', selectedExtras: [{ id: 'shortedit', quantity: 2 }] };
    const r = computeProposalCheckout(legacyProposal, sig);
    expect(r.amountGross).toBe(6720); // (5000 + 300*2) * 1.2
  });

  it('leaves unknown custom extras flat — the catalogue only covers known ids', () => {
    const sig = { paymentOption: 'full', selectedExtras: [{ id: 'custom_thing' }] };
    const r = computeProposalCheckout(legacyProposal, sig);
    expect(r.amountGross).toBe(6108); // (5000 + 90) * 1.2
  });

  it('an explicit fixed model beats the catalogue', () => {
    const prop = {
      ...legacyProposal,
      optionalExtras: [{ id: 'voiceover', price: 125, priceModel: 'fixed' }],
    };
    const sig = { paymentOption: 'full', selectedExtras: [{ id: 'voiceover' }] };
    const r = computeProposalCheckout(prop, sig);
    expect(r.amountGross).toBe(6150); // (5000 + 125) * 1.2 — not scaled
  });

  it('applies a percentage discount from the proposal (not the signature)', () => {
    const prop = { ...baseProposal, discount: { type: 'percent', value: 10 } };
    const sig = { paymentOption: 'full', discountApplied: { amount: 4999 } }; // tampered — ignored
    const r = computeProposalCheckout(prop, sig);
    // (5000 - 500) * 1.2 = 5400
    expect(r.amountGross).toBe(5400);
  });

  // Blanket extras discount: a single % off every optional extra, set on the
  // proposal. The client is shown the reduced prices, so the checkout floor has
  // to be computed the same way — otherwise a correct payment reads as an
  // under-payment and gets rejected.
  it('takes the blanket extras discount off every selected extra', () => {
    const prop = { ...baseProposal, extrasDiscount: { value: 15 } };
    const sig = { paymentOption: 'full', selectedExtras: [{ id: 'voiceover' }, { id: 'subtitles' }] };
    const r = computeProposalCheckout(prop, sig);
    // extras 125 + 125 = 250, less 15% = 212.50; (5000 + 212.5) * 1.2 = 6255
    expect(r.amountGross).toBe(6255);
  });

  it('leaves the base price alone — the extras discount is extras-only', () => {
    const prop = { ...baseProposal, extrasDiscount: { value: 50 } };
    const r = computeProposalCheckout(prop, { paymentOption: 'full' });
    expect(r.amountGross).toBe(6000); // 5000 * 1.2, untouched
  });

  it('discounts the per-minute scaled price, not the headline one', () => {
    const prop = { ...perMinProposal, extrasDiscount: { value: 10 } };
    const sig = { paymentOption: 'full', selectedExtras: [{ id: 'voiceover' }] };
    const r = computeProposalCheckout(prop, sig);
    // voiceover on 8 min = 125 + 7*30 = 335, less 10% = 301.50
    // (5000 + 301.5) * 1.2 = 6361.80
    expect(r.amountGross).toBe(6361.8);
  });

  it('applies the extras discount per unit, then multiplies by quantity', () => {
    const prop = { ...perMinProposal, extrasDiscount: { value: 20 } };
    const sig = { paymentOption: 'full', selectedExtras: [{ id: 'translatedsubs', quantity: 3 }] };
    const r = computeProposalCheckout(prop, sig);
    // unit 200 + 7*30 = 410, less 20% = 328; x3 = 984; (5000 + 984) * 1.2 = 7180.80
    expect(r.amountGross).toBe(7180.8);
  });

  it('stacks with the base discount and with the partner programme', () => {
    const prop = {
      ...baseProposal,
      discount: { type: 'percent', value: 10 },
      extrasDiscount: { value: 25 },
    };
    const sig = { paymentOption: 'full', selectedExtras: [{ id: 'voiceover' }] };
    const r = computeProposalCheckout(prop, sig);
    // base 5000 - 10% = 4500; extra 125 - 25% = 93.75; (4593.75) * 1.2 = 5512.50
    expect(r.amountGross).toBe(5512.5);
  });

  it('ignores a zero, absent or negative extras discount', () => {
    const sig = { paymentOption: 'full', selectedExtras: [{ id: 'voiceover' }] };
    const full = computeProposalCheckout(baseProposal, sig).amountGross;
    expect(computeProposalCheckout({ ...baseProposal, extrasDiscount: { value: 0 } }, sig).amountGross).toBe(full);
    expect(computeProposalCheckout({ ...baseProposal, extrasDiscount: { value: -20 } }, sig).amountGross).toBe(full);
  });

  it('ignores an extras discount invented in the signature', () => {
    const sig = {
      paymentOption: 'full',
      selectedExtras: [{ id: 'voiceover', price: 1 }],
      extrasDiscountApplied: { rate: 0.9 }, // tampered — the proposal has none
    };
    const r = computeProposalCheckout(baseProposal, sig);
    expect(r.amountGross).toBe(6150); // (5000 + 125) * 1.2, undiscounted
  });

  // A project gets ONE discount. When the salesperson has already discounted the
  // project by hand, opting into the Partner Programme discounts the minutes
  // being added — not the project a second time. (Before this, opting in
  // replaced the manual discount, which could leave a discounted project costing
  // MORE after opting in than before.)
  it('does not stack the partner discount on a manually discounted project', () => {
    const prop = { ...baseProposal, discount: { type: 'percent', value: 20 } };
    const sig = { paymentOption: 'full', partnerSelected: true, partnerCredits: 1 };
    const r = computeProposalCheckout(prop, sig);
    // project 5000 - 20% = 4000 (NOT 4000*0.9, and not 5000*0.9)
    expect(r.projectExVat).toBe(4000);
    // the credit minute still gets the tier rate: 1250 * 0.9 = 1125
    expect(r.partnerExVat).toBe(1125);
    expect(r.amountGross).toBe(6150); // (4000 + 1125) * 1.2
  });

  it('keeps the manual discount even though the client opted in', () => {
    const prop = { ...baseProposal, discount: { type: 'amount', value: 1000 } };
    const sig = { paymentOption: 'full', partnerSelected: true, partnerCredits: 1 };
    expect(computeProposalCheckout(prop, sig).projectExVat).toBe(4000);
  });

  it('still discounts the project when there is no manual discount', () => {
    const sig = { paymentOption: 'full', partnerSelected: true, partnerCredits: 1 };
    expect(computeProposalCheckout(baseProposal, sig).projectExVat).toBe(4500); // 5000 * 0.9
  });

  // Proposals signed before the rule changed were priced the old way. The floor
  // takes whichever of the two staff-priced figures is lower, so those payments
  // aren't rejected — a small manual discount used to be REPLACED by a larger
  // partner one, making the old total the lower of the two.
  it('accepts a payment priced under the old stacking rule', () => {
    const prop = { ...baseProposal, discount: { type: 'percent', value: 5 } };
    const sig = { paymentOption: 'full', partnerSelected: true, partnerCredits: 1 };
    const r = computeProposalCheckout(prop, sig);
    // new rule: 5000 - 5% = 4750. old rule: 5000 * 0.9 = 4500. Floor is 4500.
    expect(r.projectExVat).toBe(4500);
    expect(r.amountGross).toBe(6750); // (4500 + 1125) * 1.2
  });

  it('the legacy floor never lets a partner payment come in under either rule', () => {
    // Manual 20% beats the 10% partner rate, so the new rule is already the
    // lower figure and the allowance changes nothing.
    const prop = { ...baseProposal, discount: { type: 'percent', value: 20 } };
    const sig = { paymentOption: 'full', partnerSelected: true, partnerCredits: 1 };
    expect(computeProposalCheckout(prop, sig).projectExVat).toBe(4000);
  });

  it('leaves a free project free rather than reintroducing a price to discount', () => {
    const prop = { ...baseProposal, discount: { type: 'percent', value: 100 } };
    const sig = { paymentOption: 'full', partnerSelected: true, partnerCredits: 1 };
    const r = computeProposalCheckout(prop, sig);
    expect(r.projectExVat).toBe(0);
    expect(r.partnerExVat).toBe(1125); // the credit is still bought
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
