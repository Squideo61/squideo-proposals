// Who sees the video-credit rate card. One rule, read by the portal nav, the
// portal API guard and the CRM's Video credit card — so it's worth pinning
// rather than re-deriving in three places.
//
// The commercial line it draws: credit is the rung AFTER a first project. A
// company we've only sent a proposal to is still being quoted, and publishing
// £/min to them mid-negotiation undercuts the proposal they're reading.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock };
});

import { setSqlHandler, resetSqlMock, getSqlCalls } from './helpers/mockDb.js';
import { creditVisibleFor, creditAccessLabel, hasProjectFor } from '../api/_lib/crm/companyCredit.js';

beforeEach(() => resetSqlMock());

describe('creditVisibleFor — the default rule', () => {
  it('shows it to a client with a project in production', () => {
    expect(creditVisibleFor({ prospect: false, hasProject: true })).toBe(true);
  });

  it('hides it from a company that has only been sent a proposal', () => {
    // The case this rule was tightened for: not a crash-course prospect, but
    // not a client either — nothing of theirs has entered production.
    expect(creditVisibleFor({ prospect: false, hasProject: false })).toBe(false);
  });

  it('hides it from a crash-course prospect', () => {
    expect(creditVisibleFor({ prospect: true, hasProject: false })).toBe(false);
  });

  it('treats a missing hasProject as "no project", not as "client"', () => {
    expect(creditVisibleFor({})).toBe(false);
    expect(creditVisibleFor()).toBe(false);
  });
});

describe('creditVisibleFor — the staff override', () => {
  it('shows it to a prospect when switched on (NHS / framework buyers)', () => {
    expect(creditVisibleFor({ creditEnabled: true, prospect: true, hasProject: false })).toBe(true);
  });

  it('hides it from an established client when switched off', () => {
    expect(creditVisibleFor({ creditEnabled: false, prospect: false, hasProject: true })).toBe(false);
  });

  it('falls back to the rule when nobody has decided (NULL, not false)', () => {
    expect(creditVisibleFor({ creditEnabled: null, prospect: false, hasProject: true })).toBe(true);
    expect(creditVisibleFor({ creditEnabled: null, prospect: false, hasProject: false })).toBe(false);
  });
});

describe('creditAccessLabel', () => {
  it('agrees with the rule in every case, so the CRM badge cannot lie', () => {
    for (const creditEnabled of [true, false, null]) {
      for (const prospect of [true, false]) {
        for (const hasProject of [true, false]) {
          const args = { creditEnabled, prospect, hasProject };
          expect(creditAccessLabel(args).on).toBe(creditVisibleFor(args));
        }
      }
    }
  });

  it('tells staff a proposal is not a project', () => {
    const label = creditAccessLabel({ prospect: false, hasProject: false });
    expect(label.on).toBe(false);
    expect(label.why).toMatch(/proposal/i);
  });

  it('names the override rather than the rule when one is set', () => {
    expect(creditAccessLabel({ creditEnabled: true, hasProject: false }).why).toMatch(/switched on/i);
    expect(creditAccessLabel({ creditEnabled: false, hasProject: true }).why).toMatch(/switched off/i);
  });
});

describe('hasProjectFor', () => {
  it('counts a deal in production and a credit balance as the same thing', async () => {
    setSqlHandler(() => [{ id: 'co-in-production' }, { id: 'co-holds-credit' }]);
    const out = await hasProjectFor(['co-in-production', 'co-holds-credit', 'co-proposal-only']);
    expect(out.has('co-in-production')).toBe(true);
    expect(out.has('co-holds-credit')).toBe(true);
    expect(out.has('co-proposal-only')).toBe(false);

    const [{ text }] = getSqlCalls();
    // A deal that entered production before production_entered_at existed still
    // counts, hence both columns.
    expect(text).toMatch(/production_entered_at IS NOT NULL OR d\.production_phase IS NOT NULL/);
    // …and so does credit already paid for, via either deterministic link.
    expect(text).toMatch(/partner_subscriptions/);
    expect(text).toMatch(/manual_portalcredit_/);
  });

  it('asks nothing when there are no companies to ask about', async () => {
    const out = await hasProjectFor([]);
    expect(out.size).toBe(0);
    expect(getSqlCalls()).toHaveLength(0);
  });

  it('degrades to "no project" instead of taking the portal down', async () => {
    // This runs on every portal request. A schema surprise here must cost a
    // hidden rate card (which staff can override), never a 500 on the whole
    // portal session.
    setSqlHandler(() => Promise.reject(new Error('column "company_id" does not exist')));
    const out = await hasProjectFor(['co-1']);
    expect(out.size).toBe(0);
  });
});
