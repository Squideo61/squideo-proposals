import { describe, it, expect } from 'vitest';
import {
  academyFlags, academyTotals, alertsFor, billingDue, isBilled, isLowUsage, planPeriod,
  cardPaymentLabel, cardRenewsAt, cardStateFor, cardStatusFrom, grossPence, holdUntilTrialEnds, splitGross,
} from '../api/_lib/crm/academyBilling.js';

// An academy as the platform's private API hands it over: a Starter plan,
// billed monthly from 20 October, comfortably within its allowance.
const academy = ({ summary = {}, ...rest } = {}) => ({
  id: 't1',
  name: 'ASH Waste Services',
  demo: false,
  crmCompanyId: 'co_1',
  monthlyValue: 9900,
  ...rest,
  summary: {
    plan: { slug: 'starter', name: 'Starter', learners: 75, monthly: 9900, annual: 99000, quoted: false },
    cap: 75,
    billingPeriod: 'monthly',
    planStartedAt: '2026-10-20T09:00:00Z',
    renewsAt: '2026-11-20T09:00:00Z',
    trial: { phase: 'none' },
    usage: { thisMonth: 50, months: [{ month: '2026-10-01', learners: 50 }], average: 50 },
    check: { status: 'within', overTwoMonths: false, suggested: null },
    extra: { last: null },
    request: null,
    ...summary,
  },
});

const NOW = new Date('2026-11-05T12:00:00Z');

describe('planPeriod', () => {
  it('finds the month or year in progress, counted from the plan start', () => {
    expect(planPeriod('2026-10-20T09:00:00Z', 'monthly', NOW)).toEqual({
      from: new Date('2026-10-20T09:00:00Z'), to: new Date('2026-11-20T09:00:00Z'),
    });
    expect(planPeriod('2026-10-20T09:00:00Z', 'annual', new Date('2027-03-01T00:00:00Z'))).toEqual({
      from: new Date('2026-10-20T09:00:00Z'), to: new Date('2027-10-20T09:00:00Z'),
    });
  });

  it('clamps to the end of a short month, as the platform does', () => {
    const p = planPeriod('2026-01-31T09:00:00Z', 'monthly', new Date('2026-03-05T00:00:00Z'));
    expect(p.from.toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(p.to.toISOString().slice(0, 10)).toBe('2026-03-31');
  });
});

describe('billingDue', () => {
  it('bills the plan period in progress, in advance, once', () => {
    const [line] = billingDue(academy(), [], NOW);
    expect(line).toEqual({
      kind: 'plan',
      periodKey: 'plan:2026-10-20',
      label: 'Squideo Academy, Starter plan (monthly), 20 Oct 2026 to 19 Nov 2026',
      amount: 99,
    });
    expect(billingDue(academy(), [{ kind: 'plan', periodKey: 'plan:2026-10-20' }], NOW)).toEqual([]);
  });

  it('bills a year up front on an annual plan', () => {
    const a = academy({ summary: { billingPeriod: 'annual', renewsAt: '2027-10-20T09:00:00Z' } });
    const [line] = billingDue(a, [], NOW);
    expect(line.amount).toBe(990);
    expect(line.label).toBe('Squideo Academy, Starter plan (annual), 20 Oct 2026 to 19 Oct 2027');
  });

  it('bills the last complete statement of extra people, when there were any', () => {
    const last = { from: '2026-07-01', label: 'July to September 2026', complete: true, total: 6690 };
    const lines = billingDue(academy({ summary: { extra: { last } } }), [{ kind: 'plan', periodKey: 'plan:2026-10-20' }], NOW);
    expect(lines).toEqual([{ kind: 'extras', periodKey: 'extras:2026-07-01', label: 'Squideo Academy, extra learners, July to September 2026', amount: 66.9 }]);
    expect(billingDue(academy({ summary: { extra: { last: { ...last, total: 0 } } } }), [{ kind: 'plan', periodKey: 'plan:2026-10-20' }], NOW)).toEqual([]);
  });

  it('bills a signed set-up fee as soon as its order is applied, trial or not', () => {
    const trial = academy({ summary: { trial: { phase: 'running', daysLeft: 60 } } });
    const orders = [
      { id: 'ord_1', status: 'applied', setupFee: 500, planName: 'Team' },
      { id: 'ord_2', status: 'waiting', setupFee: 300 },
    ];
    expect(billingDue(trial, [], NOW, orders)).toEqual([
      { kind: 'setup', periodKey: 'setup:ord_1', label: 'Squideo Academy set-up (Team plan)', amount: 500 },
    ]);
    expect(billingDue(trial, [{ kind: 'setup', periodKey: 'setup:ord_1' }], NOW, orders)).toEqual([]);
  });

  it('bills nothing on a trial, Free, a quoted deal or a demo', () => {
    expect(billingDue(academy({ summary: { trial: { phase: 'running', daysLeft: 20 } } }), [], NOW)).toEqual([]);
    expect(billingDue(academy({ summary: { plan: { slug: 'free', name: 'Free', monthly: 0, annual: 0 } } }), [], NOW)).toEqual([]);
    expect(billingDue(academy({ summary: { plan: { slug: 'enterprise', name: 'Enterprise', quoted: true } } }), [], NOW)).toEqual([]);
    expect(billingDue(academy({ demo: true }), [], NOW)).toEqual([]);
    expect(isBilled(academy())).toBe(true);
  });
});

describe('isLowUsage', () => {
  const months = [{ month: '2026-10-01', learners: 10 }, { month: '2026-09-01', learners: 10 }];
  it('is a billed academy averaging a fifth of its allowance or less, over two months or more', () => {
    expect(isLowUsage(academy({ summary: { usage: { months, average: 10 } } }))).toBe(true);
    expect(isLowUsage(academy({ summary: { usage: { months, average: 20 } } }))).toBe(false);
    expect(isLowUsage(academy({ summary: { usage: { months: months.slice(0, 1), average: 10 } } }))).toBe(false);
  });
});

describe('academyFlags', () => {
  it('puts money first, then what somebody asked for', () => {
    const a = academy({ summary: { request: { plan: { slug: 'team', name: 'Team' }, at: '2026-11-01T10:00:00Z' } } });
    const flags = academyFlags(a, billingDue(a, [], NOW), NOW);
    expect(flags.map((f) => f.kind)).toEqual(['to_invoice', 'requested']);
    expect(flags[0].label).toBe('£99.00 to invoice');
  });

  it('flags an annual renewal inside a month, and never a monthly one', () => {
    const annual = academy({ summary: { billingPeriod: 'annual', planStartedAt: '2025-11-20T09:00:00Z', renewsAt: '2026-11-20T09:00:00Z' } });
    expect(academyFlags(annual, [], NOW).map((f) => f.kind)).toContain('renewal');
    expect(academyFlags(academy(), [], NOW).map((f) => f.kind)).not.toContain('renewal');
  });
});

describe('alertsFor', () => {
  it('raises each alert under a key it is sent once for', () => {
    const trial = academy({ summary: { trial: { phase: 'running', daysLeft: 20, endsAt: '2026-11-25T09:00:00Z' } } });
    expect(alertsFor(trial, NOW)).toEqual([{ kind: 'trial_ending', periodKey: '2026-11-25' }]);

    const over = academy({ summary: { check: { overTwoMonths: true } } });
    expect(alertsFor(over, NOW)).toEqual([{ kind: 'over_allowance', periodKey: '2026-Q4' }]);

    const asked = academy({ summary: { request: { plan: { slug: 'team', name: 'Team' }, at: '2026-11-01T10:00:00Z' } } });
    expect(alertsFor(asked, NOW)).toEqual([{ kind: 'plan_requested', periodKey: 'team:2026-11-01T10:00:00Z' }]);

    const renewing = academy({ summary: { billingPeriod: 'annual', planStartedAt: '2025-11-20T09:00:00Z', renewsAt: '2026-11-20T09:00:00Z' } });
    expect(alertsFor(renewing, NOW)).toEqual([{ kind: 'renewal_due', periodKey: '2026-11-20' }]);
  });

  it('never alerts about a demo', () => {
    expect(alertsFor(academy({ demo: true, summary: { check: { overTwoMonths: true } } }), NOW)).toEqual([]);
  });
});

describe('academyTotals', () => {
  it('adds up recurring revenue, trials and what is waiting to be invoiced', () => {
    const monthly = academy();
    const annual = academy({ monthlyValue: Math.round(99000 / 12), summary: { billingPeriod: 'annual' } });
    const trial = academy({ monthlyValue: 0, summary: { trial: { phase: 'running', daysLeft: 20, endsAt: '2026-11-25T09:00:00Z' } } });
    const rows = [monthly, annual, trial].map((a) => ({ ...a, due: billingDue(a, [], NOW), flags: [] }));
    const t = academyTotals(rows, NOW);
    expect(t.paying).toBe(2);
    expect(t.mrr).toBe(99 + 82.5);
    expect(t.arr).toBe((99 + 82.5) * 12);
    expect(t.trials).toBe(1);
    expect(t.trialsEndingThisMonth).toBe(1);
    expect(t.toInvoice).toBe(99 + 990);
    expect(t.toInvoiceCount).toBe(2);
  });
});

describe('paying by card', () => {
  const card = { status: 'active' };

  it('leaves the plan to Stripe, and sends extra people to the card', () => {
    const last = { from: '2026-10-01', label: 'October 2026', complete: true, total: 1300 };
    const lines = billingDue(academy({ summary: { extra: { last } } }), [], NOW, [], { card });
    expect(lines).toEqual([{ kind: 'extras', periodKey: 'extras:2026-10-01', label: 'Squideo Academy, extra learners, October 2026', amount: 13, viaCard: true }]);
    // Once the card has gone, the plan is invoiced again.
    expect(billingDue(academy(), [], NOW, [], { card: { status: 'cancelled' } })[0].kind).toBe('plan');
  });

  it('adds VAT in pence, and splits a payment back out', () => {
    expect(grossPence(9900)).toBe(11880);
    expect(grossPence(14900 * 10)).toBe(178800);
    expect(splitGross(11880)).toEqual({ exPence: 9900, vatPence: 1980 });
    expect(splitGross(1003)).toEqual({ exPence: 836, vatPence: 167 });
  });

  it('reads a Stripe subscription in the platform\'s words', () => {
    const periodEnd = Date.parse('2026-12-05T12:00:00Z') / 1000;
    const sub = (over) => ({ status: 'active', items: { data: [{ current_period_end: periodEnd }] }, ...over });
    expect(cardStatusFrom(sub())).toBe('active');
    expect(cardStatusFrom(sub({ status: 'trialing' }))).toBe('trialing');
    expect(cardStatusFrom(sub({ cancel_at_period_end: true }))).toBe('cancelling');
    expect(cardStatusFrom(sub({ status: 'past_due', cancel_at_period_end: true }))).toBe('past_due');
    expect(cardStatusFrom(sub({ status: 'canceled' }))).toBe('cancelled');
    expect(cardRenewsAt(sub())).toBe('2026-12-05T12:00:00.000Z');
    expect(cardStateFor(sub({ cancel_at_period_end: true }))).toEqual({
      status: 'cancelling', renewsAt: '2026-12-05T12:00:00.000Z', cancelAt: '2026-12-05T12:00:00.000Z',
    });
    expect(cardStateFor(sub({ status: 'canceled' }))).toBeNull();
  });

  it('holds the first charge for a trial with more than two days to run', () => {
    expect(holdUntilTrialEnds({ phase: 'running', endsAt: '2026-11-25T09:00:00Z' }, NOW)).toBe(Date.parse('2026-11-25T09:00:00Z') / 1000);
    expect(holdUntilTrialEnds({ phase: 'running', endsAt: '2026-11-06T09:00:00Z' }, NOW)).toBeNull();
    expect(holdUntilTrialEnds({ phase: 'waiting' }, NOW)).toBeNull();
    expect(holdUntilTrialEnds({ phase: 'none' }, NOW)).toBeNull();
  });

  it('describes each card payment for its Xero invoice', () => {
    const meta = { kind: 'academy_subscription', plan: 'team', planName: 'Team', billingPeriod: 'monthly' };
    const invoice = {
      billing_reason: 'subscription_cycle',
      lines: { data: [{ period: { start: Date.parse('2026-11-20T09:00:00Z') / 1000, end: Date.parse('2026-12-20T09:00:00Z') / 1000 } }] },
    };
    expect(cardPaymentLabel(meta, invoice)).toBe('Squideo Academy, Team plan (monthly), 20 Nov 2026 to 19 Dec 2026, by card');
    expect(cardPaymentLabel(meta, { billing_reason: 'subscription_update' })).toBe('Squideo Academy, change to the Team plan (monthly), for the rest of the period, by card');
    expect(cardPaymentLabel({ kind: 'academy_extras', label: 'Squideo Academy, extra learners, October 2026' }, {})).toBe('Squideo Academy, extra learners, October 2026');
  });

  it('flags a failed card payment, and does not chase a renewal the card will take', () => {
    const failing = { ...academy(), card: { status: 'past_due' } };
    expect(academyFlags(failing, [], NOW).map((f) => f.kind)).toContain('card_failed');
    const annual = { ...academy({ summary: { billingPeriod: 'annual', planStartedAt: '2025-11-20T09:00:00Z', renewsAt: '2026-11-20T09:00:00Z' } }), card };
    expect(alertsFor(annual, NOW)).toEqual([]);
  });
});
