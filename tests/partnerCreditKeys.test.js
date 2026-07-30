import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
}));

import { clientKeysForCompany, companyCreditTotals } from '../api/_lib/partnerCredits.js';
import { setSqlHandler, resetSqlMock, getSqlCalls } from './helpers/mockDb.js';

// The client portal and the CRM company page both ask this one function whose
// credit is whose. They used to each hold their own copy of the SQL, and the
// portal's resolved from a session company object with no xero_contact_id — so a
// client matched only by their Xero contact read as a full balance in the CRM
// and 0 in the portal.

const COMPANY = { id: 'co1', name: 'The Christie NHS Foundation Trust', xero_contact_id: 'xc-9' };

// Answers the company lookup, then the key query. `keys` is what the key query
// returns; the query itself is captured for assertions.
function mockCompany(company, keys = []) {
  setSqlHandler((text) => {
    if (text.includes('SELECT DISTINCT ps.client_key')) return keys.map((k) => ({ client_key: k }));
    if (text.includes('FROM companies')) return company ? [company] : [];
    return [];
  });
}

// Match the resolver's own SELECT specifically — the schema self-heal also
// touches partner_subscriptions, so a looser match would find its ALTER.
const keyQuery = () => getSqlCalls().find((c) => c.text.includes('SELECT DISTINCT ps.client_key'));

beforeEach(() => { resetSqlMock(); });

describe('clientKeysForCompany', () => {
  it('binds the company’s Xero contact even when the caller passes only an id', () => {
    mockCompany(COMPANY, ['christie']);
    return clientKeysForCompany('co1').then((keys) => {
      expect(keys).toEqual(['christie']);
      // The regression: the Xero route must be live, which it only can be if the
      // company row was loaded here rather than taken from the caller.
      expect(keyQuery().values).toContain('xc-9');
    });
  });

  it('does the same for a partial company object (the portal session shape)', async () => {
    mockCompany(COMPANY, ['christie']);
    // {id, name, logoUrl} — exactly what a portal session carries. No Xero id.
    await clientKeysForCompany({ id: 'co1', name: 'The Christie NHS Foundation Trust', logoUrl: null });
    expect(keyQuery().values).toContain('xc-9');
  });

  it('matches the client name on more than exact case — punctuation and spacing too', () => {
    mockCompany(COMPANY, []);
    return clientKeysForCompany('co1').then(() => {
      // Normalisation strips everything but a-z0-9 from both sides, so
      // "The Christie N.H.S. Foundation Trust" resolves to the same string.
      expect(keyQuery().text).toContain('regexp_replace');
      expect(keyQuery().values).toContain(COMPANY.name);
    });
  });

  it('returns [] for a missing company without running the key query', async () => {
    mockCompany(null);
    expect(await clientKeysForCompany('nope')).toEqual([]);
    expect(keyQuery()).toBeUndefined();
  });

  it('returns [] for no id at all', async () => {
    mockCompany(COMPANY);
    expect(await clientKeysForCompany(null)).toEqual([]);
    expect(await clientKeysForCompany({})).toEqual([]);
    expect(keyQuery()).toBeUndefined();
  });

  it('counts BOTH ledgers — partner credit and deal credit-based projects', async () => {
    // A client can hold credit in two unrelated places. Counting only partner
    // credit is what made a deal card read "9 credits remaining" while the same
    // client's portal read "0 min".
    setSqlHandler((text) => {
      if (text.includes('SELECT DISTINCT ps.client_key')) return [{ client_key: 'christie' }];
      if (text.includes('FROM companies')) return [COMPANY];
      if (text.includes('WITH sub_totals')) return [{ client_key: 'christie', credits_issued: 4, credits_used: 1 }];
      if (text.includes('FROM project_retainers')) return [{ id: 'r1', allocation_amount: 9, used: 3 }];
      return [];
    });
    const t = await companyCreditTotals('co1');
    expect(t.partner.remaining).toBe(3);   // 4 issued − 1 used
    expect(t.retainers.remaining).toBe(6); // 9 allocated − 3 logged
    expect(t.remaining).toBe(9);
  });

  it('still reports retainer credit when no partner client matches at all', async () => {
    setSqlHandler((text) => {
      if (text.includes('SELECT DISTINCT ps.client_key')) return [];
      if (text.includes('FROM companies')) return [COMPANY];
      if (text.includes('FROM project_retainers')) return [{ id: 'r1', allocation_amount: 9, used: 0 }];
      return [];
    });
    const t = await companyCreditTotals('co1');
    expect(t.remaining).toBe(9);
    expect(t.keys).toEqual([]);
  });

  it('lets an explicit company_id link win, and bypasses the guesses for it', () => {
    mockCompany(COMPANY, ['christie']);
    return clientKeysForCompany('co1').then(() => {
      const q = keyQuery().text;
      // Explicitly-linked clients match outright…
      expect(q).toContain('ps.company_id =');
      // …and the inferred routes only apply to clients with no link, so a
      // linked client can't also be claimed by another company's name match.
      expect(q).toContain('ps.company_id IS NULL');
    });
  });
});
