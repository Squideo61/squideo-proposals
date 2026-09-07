import { describe, it, expect } from 'vitest';
import {
  MONTHLY_MODE, frontLoadSummary, isMonthlyPlan, monthlyPlanFor, monthlyPlanProblems,
} from '../api/_lib/monthlyPlan.js';

// The Monthly Plan proposal type: the client commits to a monthly spend from
// the start, with no project up front. Every figure here is one a client signs
// and a card is charged for, so each is pinned rather than trusted.

const plan = (partnerProgramme) => ({ partnerProgramme: { mode: MONTHLY_MODE, ...partnerProgramme } });

describe('isMonthlyPlan', () => {
  it('recognises its own mode and nothing else', () => {
    expect(isMonthlyPlan(plan({}))).toBe(true);
    expect(isMonthlyPlan({ partnerProgramme: { mode: 'subscription' } })).toBe(false);
    expect(isMonthlyPlan({ partnerProgramme: { mode: 'oneoff', creditOnly: true } })).toBe(false);
    expect(isMonthlyPlan({})).toBe(false);
    expect(isMonthlyPlan(null)).toBe(false);
  });
});

describe('monthlyPlanFor', () => {
  it('prices the headline figure the client is asked to commit to', () => {
    const p = monthlyPlanFor(plan({ minutesPerMonth: 1, monthlyRatePerMin: 300 }));
    expect(p.monthlyExVat).toBe(300);
    expect(p.minutesPerMonth).toBe(1);
    expect(p.ratePerMin).toBe(300);
  });

  it('multiplies out for a bigger plan', () => {
    expect(monthlyPlanFor(plan({ minutesPerMonth: 2.5, monthlyRatePerMin: 400 })).monthlyExVat).toBe(1000);
  });

  it('rounds to the penny, so the shown, signed and charged figures agree', () => {
    // 0.5 x 333.33 is 166.665, which would otherwise print one way and charge
    // another.
    expect(monthlyPlanFor(plan({ minutesPerMonth: 0.5, monthlyRatePerMin: 333.33 })).monthlyExVat).toBe(166.67);
  });

  it('falls back to the standard rate when no monthly rate is set', () => {
    // A plan converted from another proposal type, or built before the field
    // existed, must price rather than show a free plan.
    expect(monthlyPlanFor(plan({ minutesPerMonth: 1, standardRatePerMin: 1250 })).monthlyExVat).toBe(1250);
  });

  it('never bills for nothing', () => {
    expect(monthlyPlanFor(plan({ minutesPerMonth: 0, monthlyRatePerMin: 300 })).minutesPerMonth).toBe(0.5);
    expect(monthlyPlanFor(plan({ minutesPerMonth: -4, monthlyRatePerMin: 300 })).minutesPerMonth).toBe(0.5);
  });

  it('holds minutes to the half, like every other minutes field', () => {
    expect(monthlyPlanFor(plan({ minutesPerMonth: 1.3, monthlyRatePerMin: 300 })).minutesPerMonth).toBe(1.5);
  });
});

describe('front-loading', () => {
  it('works out how long an advance takes to pay off', () => {
    const p = monthlyPlanFor(plan({ minutesPerMonth: 1, monthlyRatePerMin: 300, frontLoadMinutes: 6 }));
    expect(p.payOffMonths).toBe(6);
    expect(p.frontLoadValue).toBe(1800);
  });

  it('rounds the pay-off up, because a part month still needs a payment', () => {
    // 5 minutes advanced against 2 a month is two and a half months of
    // payments, which in practice is three.
    expect(monthlyPlanFor(plan({ minutesPerMonth: 2, monthlyRatePerMin: 300, frontLoadMinutes: 5 })).payOffMonths).toBe(3);
  });

  it('is absent when nothing is advanced', () => {
    const p = monthlyPlanFor(plan({ minutesPerMonth: 1, monthlyRatePerMin: 300 }));
    expect(p.hasFrontLoad).toBe(false);
    expect(p.payOffMonths).toBe(0);
    expect(frontLoadSummary(plan({ minutesPerMonth: 1, monthlyRatePerMin: 300 }))).toBe(null);
  });

  it('describes the advance in the words the proposal uses', () => {
    expect(frontLoadSummary(plan({ minutesPerMonth: 1, monthlyRatePerMin: 300, frontLoadMinutes: 1 })).label)
      .toBe('1 minute');
    expect(frontLoadSummary(plan({ minutesPerMonth: 1, monthlyRatePerMin: 300, frontLoadMinutes: 6 })).label)
      .toBe('6 minutes');
    expect(frontLoadSummary(plan({ minutesPerMonth: 1, monthlyRatePerMin: 300, frontLoadMinutes: 1.5 })).label)
      .toBe('1.5 minutes');
  });
});

describe('the minimum term', () => {
  it('totals the commitment when there is a term', () => {
    const p = monthlyPlanFor(plan({ minutesPerMonth: 1, monthlyRatePerMin: 300, minTermMonths: 12 }));
    expect(p.commitmentExVat).toBe(3600);
    expect(p.hasTerm).toBe(true);
  });

  it('is absent by default, because a plan with no advance is cancel-any-time', () => {
    const p = monthlyPlanFor(plan({ minutesPerMonth: 1, monthlyRatePerMin: 300 }));
    expect(p.hasTerm).toBe(false);
    expect(p.commitmentExVat).toBe(0);
  });
});

describe('monthlyPlanProblems', () => {
  it('passes a sound cancel-any-time plan', () => {
    expect(monthlyPlanProblems(plan({ minutesPerMonth: 1, monthlyRatePerMin: 300 }))).toEqual([]);
  });

  it('passes a front-loaded plan whose term covers the advance', () => {
    expect(monthlyPlanProblems(plan({
      minutesPerMonth: 1, monthlyRatePerMin: 300, frontLoadMinutes: 6, minTermMonths: 12,
    }))).toEqual([]);
  });

  it('refuses to front-load with no term at all', () => {
    // The exposure this whole rule exists for: six minutes produced, one
    // payment taken, client gone.
    const problems = monthlyPlanProblems(plan({
      minutesPerMonth: 1, monthlyRatePerMin: 300, frontLoadMinutes: 6,
    }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('minimum term');
  });

  it('refuses a term shorter than the advance takes to clear', () => {
    const problems = monthlyPlanProblems(plan({
      minutesPerMonth: 1, monthlyRatePerMin: 300, frontLoadMinutes: 6, minTermMonths: 3,
    }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('shorter than');
  });

  it('accepts a term exactly as long as the pay-off', () => {
    expect(monthlyPlanProblems(plan({
      minutesPerMonth: 1, monthlyRatePerMin: 300, frontLoadMinutes: 6, minTermMonths: 6,
    }))).toEqual([]);
  });

  it('catches a plan that would bill nothing', () => {
    const problems = monthlyPlanProblems(plan({ minutesPerMonth: 1, monthlyRatePerMin: 0 }));
    expect(problems.join(' ')).toContain('£0 a month');
  });
});
