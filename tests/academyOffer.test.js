import { describe, it, expect } from 'vitest';
import {
  academyOffer, allowanceText, money, offerHint, perHead, priceText, termsText,
} from '../src/lib/academyOffer.js';

// Team, as the academy platform's price list hands it over: pence.
const team = { slug: 'team', name: 'Team', learners: 200, monthly: 14900, annual: 149000, extra: 75 };
const proposal = (academy) => ({ academy: { enabled: true, plan: team, billingPeriod: 'monthly', ...academy } });

describe('academyOffer', () => {
  it('turns the stored plan into pounds, with the free share over the allowance', () => {
    expect(academyOffer(proposal({ setupFee: 750 }))).toEqual({
      slug: 'team', name: 'Team', learners: 200, annual: false, price: 149, monthly: 149, freeMonths: 0,
      extra: 0.75, freeOver: 20, setupFee: 750, description: '',
    });
  });

  it('prices a year up front on an annual plan, with the months it saves', () => {
    const o = academyOffer(proposal({ billingPeriod: 'annual' }));
    expect([o.price, o.freeMonths]).toEqual([1490, 2]);
  });

  it('is nothing when switched off or without a priced plan', () => {
    expect(academyOffer({})).toBeNull();
    expect(academyOffer(proposal({ enabled: false }))).toBeNull();
    expect(academyOffer(proposal({ plan: null }))).toBeNull();
    expect(academyOffer(proposal({ plan: { slug: 'free', monthly: 0 } }))).toBeNull();
  });
});

describe('the words', () => {
  it('writes money the way the page does', () => {
    expect([money(149), money(1490), money(99.5), perHead(0.75), perHead(1.3)]).toEqual(['£149', '£1,490', '£99.50', '75p', '£1.30']);
  });

  it('says what a monthly plan is and costs', () => {
    const o = academyOffer(proposal());
    expect(allowanceText(o)).toBe('Up to 200 active learners a month');
    expect(priceText(o)).toBe('£149 a month');
    expect(termsText(o)).toEqual([
      'Billed monthly. Cancel any time: there is no minimum term.',
      'Nobody is locked out in a busy month. If more than 200 people learn, the first 20 extra are free and each one after that is 75p + VAT, invoiced once the month ends.',
      'Invoiced separately from the project: it is not part of the project price.',
    ]);
  });

  it('says an annual plan is paid up front and its extras quarterly', () => {
    const o = academyOffer(proposal({ billingPeriod: 'annual' }));
    expect(priceText(o)).toBe('£1,490 a year');
    const [billing, extras] = termsText(o, { vat: false });
    expect(billing).toBe('Billed yearly in advance, which works out at 2 months free.');
    expect(extras).toContain('75p, invoiced once the quarter ends.');
  });

  it('gives the builder a one-line hint', () => {
    expect(offerHint(proposal())).toBe('Team, £149 a month');
    expect(offerHint(proposal({ plan: null }))).toBe('Choose a plan');
    expect(offerHint({})).toBe('Off');
  });
});
