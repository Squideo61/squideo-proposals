import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
}));

import { companiesForClientKey, companyMatchesByClientKey } from '../api/_lib/partnerCredits.js';
import { setSqlHandler, resetSqlMock, getSqlCalls } from './helpers/mockDb.js';

// The reverse lookup behind the Partners & Credits organisation row: a credit
// balance that resolves to no company is invisible to the client — no company
// page, and their portal's Video credit reads "0 min". Staff couldn't see that
// was happening, which is how Generis's credit sat unlinked.

const matchQuery = () => getSqlCalls().find((c) => c.text.includes('SELECT s.client_key, c.id, c.name'));

function mockMatches(rows) {
  setSqlHandler((text) => (text.includes('SELECT s.client_key, c.id, c.name') ? rows : []));
}

beforeEach(() => { resetSqlMock(); });

describe('companiesForClientKey', () => {
  it('names the route each match came through', async () => {
    mockMatches([{ client_key: 'generis', id: 'co1', name: 'Generis', by_link: false, by_proposal: false, by_xero: false, by_name: true }]);
    expect(await companiesForClientKey('generis')).toEqual([
      { id: 'co1', name: 'Generis', explicit: false, matchedBy: ['name match'] },
    ]);
  });

  it('flags an explicit link, so the UI can offer to unlink it', async () => {
    mockMatches([{ client_key: 'generis', id: 'co1', name: 'Generis Ltd', by_link: true, by_proposal: false, by_xero: false, by_name: false }]);
    const [co] = await companiesForClientKey('generis');
    expect(co.explicit).toBe(true);
    expect(co.matchedBy).toEqual(['explicit link']);
  });

  it('reports no company at all — the case that reads as 0 in the portal', async () => {
    mockMatches([]);
    expect(await companiesForClientKey('generis')).toEqual([]);
  });

  it('does not query for an empty key', async () => {
    mockMatches([]);
    expect(await companiesForClientKey(null)).toEqual([]);
    expect(matchQuery()).toBeUndefined();
  });

  it('mirrors clientKeysForCompany’s four routes, so the two can’t disagree', async () => {
    mockMatches([]);
    await companiesForClientKey('generis');
    const q = matchQuery().text;
    expect(q).toContain('s.company_id = c.id');           // explicit link
    expect(q).toContain('s.deal_company_id = c.id');      // proposal → deal
    expect(q).toContain('s.xero_contact_id = c.xero_contact_id');
    expect(q).toContain('s.norm_name = c.norm_name');     // normalised name
  });
});

describe('companyMatchesByClientKey', () => {
  it('groups every client’s matches by key for the list view', async () => {
    mockMatches([
      { client_key: 'generis', id: 'co1', name: 'Generis', by_link: true, by_proposal: false, by_xero: false, by_name: false },
      { client_key: 'generis', id: 'co2', name: 'Generis Media', by_link: false, by_proposal: false, by_xero: false, by_name: true },
      { client_key: 'ashwaste', id: 'co3', name: 'ASH Waste', by_link: false, by_proposal: true, by_xero: false, by_name: false },
    ]);
    const byKey = await companyMatchesByClientKey(null);
    expect(byKey.get('generis').map((c) => c.id)).toEqual(['co1', 'co2']);
    expect(byKey.get('ashwaste')[0].matchedBy).toEqual(['linked proposal']);
    // A client with no match is simply absent — the list renders that as the
    // "No organisation" flag.
    expect(byKey.get('nobody')).toBeUndefined();
  });

  it('scopes to the keys asked for, and passes them as an array parameter', async () => {
    mockMatches([]);
    await companyMatchesByClientKey(['generis']);
    expect(matchQuery().values).toContainEqual(['generis']);
  });
});
