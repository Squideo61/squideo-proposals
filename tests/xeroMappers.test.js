import { describe, it, expect } from 'vitest';
import {
  formatProposalNumber,
  lineItemsForProject,
  depositLineItems,
  lineItemsForDiscountedProject,
  lineItemsForPartnerFirstMonth,
  lineItemsForPartnerMonthly,
} from '../api/_lib/xeroMappers.js';

describe('formatProposalNumber', () => {
  it('zero-pads the sequence to 3 digits', () => {
    expect(formatProposalNumber(2026, 7)).toBe('Squideo 2026-007');
    expect(formatProposalNumber(2026, 142)).toBe('Squideo 2026-142');
  });

  it('returns null when year or seq is missing / zero', () => {
    expect(formatProposalNumber(null, 7)).toBeNull();
    expect(formatProposalNumber(2026, 0)).toBeNull();
    expect(formatProposalNumber(2026, null)).toBeNull();
    expect(formatProposalNumber(undefined, undefined)).toBeNull();
  });
});

describe('lineItemsForProject', () => {
  const proposal = { proposalTitle: 'Brand video', vatRate: 20, basePrice: 1000 };

  it('renders a single base line at the base price when no extras are signed', () => {
    expect(lineItemsForProject(proposal, {}, null)).toEqual([
      {
        description: 'Brand video',
        quantity: 1,
        unitAmount: 1000,
        taxType: 'OUTPUT2',
        accountCode: '200',
      },
    ]);
  });

  it('uses TAX_NONE when vatRate is 0', () => {
    expect(lineItemsForProject({ ...proposal, vatRate: 0 }, {}, null)[0].taxType).toBe('NONE');
  });

  it('prefixes the description with the proposal number when provided', () => {
    const lines = lineItemsForProject(proposal, {}, 'Squideo 2026-005');
    expect(lines[0].description).toBe('Squideo 2026-005 — Brand video');
  });

  it('uses signed.selectedVideoOption.price when present (overrides basePrice)', () => {
    const lines = lineItemsForProject(proposal, { selectedVideoOption: { price: 1500 } }, null);
    expect(lines[0].unitAmount).toBe(1500);
  });

  it('falls back to clientName then "Video production" when no title is set', () => {
    expect(lineItemsForProject({ clientName: 'Acme', vatRate: 20 }, {}, null)[0].description).toBe('Acme');
    expect(lineItemsForProject({ vatRate: 20 }, {}, null)[0].description).toBe('Video production');
  });

  it('appends extras with language suffix and respects quantity', () => {
    const signed = {
      selectedExtras: [
        { id: 'subs', label: 'Subtitles', price: 50, quantity: 1, languages: 'EN, FR' },
        { label: 'Extra scene', price: 200, quantity: 2 },
      ],
    };
    const lines = lineItemsForProject(proposal, signed, null);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({ description: 'Subtitles — EN, FR', quantity: 1, unitAmount: 50 });
    expect(lines[2]).toMatchObject({ description: 'Extra scene', quantity: 2, unitAmount: 200 });
  });

  it('clamps extra quantity to at least 1 even if 0 / negative is supplied', () => {
    const signed = { selectedExtras: [{ label: 'Weird', price: 99, quantity: 0 }] };
    expect(lineItemsForProject(proposal, signed, null)[1].quantity).toBe(1);
  });

  it('coerces non-numeric base price to 0 (defensive)', () => {
    expect(lineItemsForProject({ proposalTitle: 'X', vatRate: 20 }, {}, null)[0].unitAmount).toBe(0);
  });
});

describe('depositLineItems', () => {
  it('halves unit amounts and tags the description with the deposit percent', () => {
    const proposal = { proposalTitle: 'Brand video', vatRate: 20, basePrice: 1000 };
    const signed = { selectedExtras: [{ label: 'Subs', price: 100, quantity: 1 }] };
    const lines = depositLineItems(proposal, signed, 0.5, null);
    expect(lines[0]).toMatchObject({ description: 'Brand video (50% deposit)', unitAmount: 500 });
    expect(lines[1]).toMatchObject({ description: 'Subs (50% deposit)', unitAmount: 50 });
  });

  it('supports arbitrary fractions', () => {
    const lines = depositLineItems({ proposalTitle: 'X', vatRate: 20, basePrice: 1000 }, {}, 0.4, null);
    expect(lines[0].unitAmount).toBe(400);
    expect(lines[0].description).toBe('X (40% deposit)');
  });

  it('rounds non-integer fractional results to 2 decimal places', () => {
    const lines = depositLineItems({ proposalTitle: 'X', vatRate: 20, basePrice: 333.34 }, {}, 0.5, null);
    expect(lines[0].unitAmount).toBe(166.67);
  });
});

describe('lineItemsForDiscountedProject', () => {
  it('applies the discount factor and tags the description', () => {
    const lines = lineItemsForDiscountedProject(
      { proposalTitle: 'Brand video', vatRate: 20, basePrice: 1000 },
      { amountBreakdown: { discountRate: 0.15 } },
      null,
    );
    expect(lines[0]).toMatchObject({
      description: 'Brand video (Partner discount 15.0%)',
      unitAmount: 850,
    });
  });

  it('skips the discount tag when discount is 0', () => {
    const lines = lineItemsForDiscountedProject(
      { proposalTitle: 'Brand video', vatRate: 20, basePrice: 1000 },
      {},
      null,
    );
    expect(lines[0].description).toBe('Brand video');
    expect(lines[0].unitAmount).toBe(1000);
  });
});

describe('lineItemsForPartnerFirstMonth', () => {
  it('builds one line with credits as quantity and rate-per-credit as unitAmount', () => {
    const lines = lineItemsForPartnerFirstMonth(
      { vatRate: 20 },
      { partnerCredits: 3, amountBreakdown: { partnerExVat: 600 } },
      null,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ quantity: 3, unitAmount: 200, accountCode: '200', taxType: 'OUTPUT2' });
    expect(lines[0].description).toContain('3 min credits');
  });

  it('singularises "credit" when there is exactly one', () => {
    const lines = lineItemsForPartnerFirstMonth(
      { vatRate: 20 },
      { partnerCredits: 1, amountBreakdown: { partnerExVat: 200 } },
      null,
    );
    expect(lines[0].description).toContain('1 min credit');
    expect(lines[0].description).not.toContain('1 min credits');
  });

  it('prefixes the description with the proposal number when provided', () => {
    const lines = lineItemsForPartnerFirstMonth(
      { vatRate: 20 },
      { partnerCredits: 2, amountBreakdown: { partnerExVat: 400 } },
      'Squideo 2026-001',
    );
    expect(lines[0].description.startsWith('Squideo 2026-001 — ')).toBe(true);
  });
});

describe('lineItemsForPartnerMonthly', () => {
  it('adds the month label to the description', () => {
    const lines = lineItemsForPartnerMonthly(
      { vatRate: 20 },
      { partnerCredits: 2, amountBreakdown: { partnerExVat: 400 } },
      3,
      'Squideo 2026-001',
    );
    expect(lines[0].description).toContain('— month 3');
    expect(lines[0].description).toContain('Squideo 2026-001');
    expect(lines[0].unitAmount).toBe(200);
  });

  it('omits the month label when monthNumber is falsy', () => {
    const lines = lineItemsForPartnerMonthly(
      { vatRate: 20 },
      { partnerCredits: 1, amountBreakdown: { partnerExVat: 100 } },
      null,
      null,
    );
    expect(lines[0].description).not.toContain('month');
  });
});
