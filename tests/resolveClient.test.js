import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
}));
vi.mock('../api/_lib/crm/shared.js', () => ({
  makeId: vi.fn((prefix) => `${prefix}_NEW`),
  trimOrNull: (s) => (typeof s === 'string' && s.trim() ? s.trim() : null),
}));

import { resolveClientRoute } from '../api/_lib/crm/clientResolver.js';
import { setSqlHandler, resetSqlMock, getSqlCalls } from './helpers/mockDb.js';

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

function fakeReq(body, method = 'POST') {
  return { method, body };
}

beforeEach(() => resetSqlMock());

describe('resolveClientRoute — input validation', () => {
  it('400s when both names are empty', async () => {
    const res = fakeRes();
    await resolveClientRoute(fakeReq({ clientName: '', businessName: '   ' }), res);
    expect(res.statusCode).toBe(400);
  });
  it('405s on non-POST', async () => {
    const res = fakeRes();
    await resolveClientRoute(fakeReq({}, 'GET'), res);
    expect(res.statusCode).toBe(405);
  });
});

describe('resolveClientRoute — both names match existing', () => {
  it('returns existing IDs without creating', async () => {
    // Sequence: find contact → find company → (no contact.company_id conflict
    // path since contact has matching company) → done. No proposalId, so no
    // deal/proposal UPDATEs.
    const queue = [
      [{ id: 'ct_existing', email: 'a@x.com', name: 'Joe Smith', company_id: 'co_existing', provisional: false }],
      [{ id: 'co_existing', name: 'Acme Ltd', domain: null }],
      [{ id: 'co_existing', name: 'Acme Ltd', domain: null }], // contact.company_id lookup
    ];
    let i = 0;
    setSqlHandler(() => queue[i++] || []);

    const res = fakeRes();
    await resolveClientRoute(fakeReq({ clientName: 'Joe Smith', businessName: 'Acme Ltd' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.matched).toEqual({ contact: true, company: true });
    expect(res.body.created).toEqual({ contact: false, company: false });
    expect(res.body.contact.id).toBe('ct_existing');
    expect(res.body.company.id).toBe('co_existing');
    expect(res.body.conflict).toBeNull();
  });
});

describe('resolveClientRoute — both new', () => {
  it('creates contact + company and links them', async () => {
    // Sequence:
    // 1. findContactByExactName → []
    // 2. findCompanyByExactName → []
    // 3. INSERT companies
    // 4. SELECT newly inserted company
    // 5. INSERT contacts
    // 6. SELECT newly inserted contact
    const queue = [
      [],                                                              // no contact match
      [],                                                              // no company match
      undefined,                                                       // INSERT companies
      [{ id: 'co_NEW', name: 'New Co', domain: null }],                // SELECT new company
      undefined,                                                       // INSERT contacts
      [{ id: 'ct_NEW', email: null, name: 'New Person', company_id: 'co_NEW', provisional: false }],
    ];
    let i = 0;
    setSqlHandler(() => queue[i++]);

    const res = fakeRes();
    await resolveClientRoute(fakeReq({ clientName: 'New Person', businessName: 'New Co' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.matched).toEqual({ contact: false, company: false });
    expect(res.body.created).toEqual({ contact: true, company: true });
    expect(res.body.contact.id).toBe('ct_NEW');
    expect(res.body.company.id).toBe('co_NEW');
  });
});

describe('resolveClientRoute — contact matches, company new', () => {
  it('reuses the contact, creates the company, and attaches it', async () => {
    // Existing contact has NO company_id, so:
    // 1. find contact → row (company_id null)
    // 2. find company by name → []
    // 3. INSERT companies
    // 4. SELECT new company
    // 5. UPDATE contacts attaching company_id (no new contact INSERT)
    const queue = [
      [{ id: 'ct_existing', email: null, name: 'Joe', company_id: null, provisional: false }],
      [],
      undefined,
      [{ id: 'co_NEW', name: 'New Co', domain: null }],
      undefined, // UPDATE contacts
    ];
    let i = 0;
    setSqlHandler(() => queue[i++]);

    const res = fakeRes();
    await resolveClientRoute(fakeReq({ clientName: 'Joe', businessName: 'New Co' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.matched.contact).toBe(true);
    expect(res.body.matched.company).toBe(false);
    expect(res.body.created.contact).toBe(false);
    expect(res.body.created.company).toBe(true);
    expect(res.body.contact.id).toBe('ct_existing');
    expect(res.body.company.id).toBe('co_NEW');
  });
});

describe('resolveClientRoute — company matches, contact new', () => {
  it('reuses the company and creates the contact under it', async () => {
    // 1. find contact → []
    // 2. find company → row
    // 3. INSERT contacts (with company_id from match)
    // 4. SELECT new contact
    const queue = [
      [],
      [{ id: 'co_existing', name: 'Acme Ltd', domain: null }],
      undefined,
      [{ id: 'ct_NEW', email: null, name: 'New Person', company_id: 'co_existing', provisional: false }],
    ];
    let i = 0;
    setSqlHandler(() => queue[i++]);

    const res = fakeRes();
    await resolveClientRoute(fakeReq({ clientName: 'New Person', businessName: 'Acme Ltd' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.matched).toEqual({ contact: false, company: true });
    expect(res.body.created).toEqual({ contact: true, company: false });
    expect(res.body.contact.companyId).toBe('co_existing');
  });
});

describe('resolveClientRoute — conflict', () => {
  it('flags when an existing contact is linked to a different company', async () => {
    // Existing Joe Smith linked to co_beta, but user typed "Acme Ltd".
    // 1. find contact → row (company_id co_beta)
    // 2. find company by name "Acme Ltd" → [] (Acme doesn't exist yet at all)
    // 3. SELECT companies for contact.company_id → co_beta
    //    → conflict detected; we DON'T create a new "Acme Ltd" because the
    //      logic recognises the contact already lives somewhere.
    //    Wait — current implementation DOES still create the missing
    //    company. We need to verify that behaviour: it should still flag
    //    the conflict but create Acme as a new option.
    const queue = [
      [{ id: 'ct_existing', email: null, name: 'Joe Smith', company_id: 'co_beta', provisional: false }],
      [],
      [{ id: 'co_beta', name: 'Beta Corp', domain: null }],
      // After detecting conflict, the code falls through to creating Acme:
      undefined,                                                    // INSERT companies
      [{ id: 'co_NEW', name: 'Acme Ltd', domain: null }],           // SELECT new company
    ];
    let i = 0;
    setSqlHandler(() => queue[i++]);

    const res = fakeRes();
    await resolveClientRoute(fakeReq({ clientName: 'Joe Smith', businessName: 'Acme Ltd' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.conflict).not.toBeNull();
    expect(res.body.conflict.kind).toBe('contact_linked_to_different_company');
    expect(res.body.conflict.linkedCompany.id).toBe('co_beta');
    expect(res.body.conflict.typedBusinessName).toBe('Acme Ltd');
  });
});

describe('resolveClientRoute — proposal/deal sync', () => {
  it('updates deal_<proposalId> when proposalId is supplied AND deal exists', async () => {
    const queue = [
      [{ id: 'ct_existing', email: null, name: 'Joe', company_id: 'co_existing', provisional: false }],
      [{ id: 'co_existing', name: 'Acme', domain: null }],
      [{ id: 'co_existing', name: 'Acme', domain: null }],          // contact.company_id lookup
      [{ id: 'deal_PROP1', primary_contact_id: null, company_id: null }], // SELECT deals
      undefined,                                                    // UPDATE deals
      undefined,                                                    // UPDATE proposals data
    ];
    let i = 0;
    setSqlHandler(() => queue[i++]);

    const res = fakeRes();
    await resolveClientRoute(fakeReq({
      clientName: 'Joe',
      businessName: 'Acme',
      proposalId: 'PROP1',
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.dealUpdated).toBe('deal_PROP1');

    // Sanity: the calls log should include an UPDATE deals.
    const sqlText = getSqlCalls().map((c) => c.text).join('\n');
    expect(sqlText).toContain('UPDATE deals');
    expect(sqlText).toContain("'{_contactId}'");
  });

  it('skips deal sync when proposalId is supplied but no auto-deal exists', async () => {
    const queue = [
      [{ id: 'ct_existing', email: null, name: 'Joe', company_id: 'co_existing', provisional: false }],
      [{ id: 'co_existing', name: 'Acme', domain: null }],
      [{ id: 'co_existing', name: 'Acme', domain: null }],
      [],                                                           // SELECT deals → none
    ];
    let i = 0;
    setSqlHandler(() => queue[i++]);

    const res = fakeRes();
    await resolveClientRoute(fakeReq({
      clientName: 'Joe',
      businessName: 'Acme',
      proposalId: 'NOPE',
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.dealUpdated).toBeNull();
  });
});
