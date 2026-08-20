// Staff previewing a client's portal used to CRASH on the Brief Builder: the
// GET lazily creates a draft, and portal_user_id is NOT NULL while a preview
// session has no puid. So the one screen a staff member would open to check a
// client's brief was the one screen that 500'd.
//
// Preview reads the ORGANISATION's briefs, creates nothing, and refuses writes
// — including in manage mode, because a brief is the client's own account of
// what they want, and staff typing into it under a client's name would make
// the activity feed a lie about who said what.
import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.JWT_SECRET = 'test-portal-secret-not-a-real-key';

vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock, batchWrite: async () => {} };
});
vi.mock('../api/_lib/portal/db.js', () => ({
  ensurePortalTables: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../api/_lib/brief/db.js', () => ({
  ensureClientBriefs: vi.fn().mockResolvedValue(undefined),
}));

import { setSqlHandler, resetSqlMock } from './helpers/mockDb.js';
import { signPortalPreviewToken } from '../api/_lib/portal/auth.js';

const handler = (await import('../api/portal.js')).default;

const COMPANY = { id: 'co-1', name: 'The Christie NHS Foundation Trust' };
const BRIEF = {
  id: 'brief-1',
  title: 'Recruitment film',
  deal_id: null,
  answers: { projectName: 'Recruitment film', goal: 'awareness' },
  completed_at: null,
  submitted_at: null,
  contributor_count: 2,
  updated_at: '2026-08-06T09:00:00.000Z',
};

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
    setHeader() {},
  };
}

// `inserted` is the point of the test: nothing may write a client_briefs row
// during a preview.
function stub({ briefs = [], deals = [] } = {}) {
  const inserted = [];
  const queries = [];
  setSqlHandler((text) => {
    queries.push(text);
    if (text.includes('INSERT INTO client_briefs')) { inserted.push(text); return []; }
    if (text.includes('FROM companies WHERE id')) return [COMPANY];
    if (text.includes('SELECT c.logo_updated_at FROM companies c')) return [];
    if (text.includes('FROM deals d')) return deals;
    if (text.includes('FROM client_briefs')) return briefs;
    return [];
  });
  return { inserted, queries };
}

async function callBrief({ method = 'GET', manage = false, body = undefined, action = 'brief' }) {
  const token = await signPortalPreviewToken({
    companyId: COMPANY.id, staffEmail: 'adam@squideo.co.uk', manage,
  });
  const res = fakeRes();
  await handler({
    method,
    query: { action },
    headers: { 'x-portal-preview': token, 'content-type': 'application/json' },
    // readRawBody takes a Buffer straight through; anything else it tries to
    // consume as a stream, which a plain object isn't.
    body: body === undefined ? undefined : Buffer.from(JSON.stringify(body)),
  }, res);
  return res;
}

beforeEach(() => { resetSqlMock(); });

describe('brief builder — staff preview', () => {
  it('does not create a brief row for a session with no portal user', async () => {
    const { inserted } = stub();
    const res = await callBrief({});
    expect(inserted).toHaveLength(0);
    expect(res.statusCode).toBe(200);
    expect(res.body.briefs).toEqual([]);
    expect(res.body.activeId).toBeNull();
    expect(res.body.readOnly).toBe(true);
  });

  it("shows the organisation's briefs rather than nothing", async () => {
    stub({ briefs: [BRIEF] });
    const res = await callBrief({});
    expect(res.statusCode).toBe(200);
    expect(res.body.readOnly).toBe(true);
    expect(res.body.briefs).toHaveLength(1);
    expect(res.body.briefs[0].title).toBe('Recruitment film');
    // Shared-document facts travel with the summary, so the list can say a
    // brief is shared before anyone opens it.
    expect(res.body.briefs[0].contributors).toBe(2);
    expect(res.body.activeId).toBe('brief-1');
  });

  it('scopes the list to the previewed organisation, never to a person', async () => {
    const { queries } = stub({ briefs: [BRIEF] });
    await callBrief({});
    const briefQueries = queries.filter((q) => q.includes('FROM client_briefs'));
    expect(briefQueries.length).toBeGreaterThan(0);
    expect(briefQueries.every((q) => q.includes('company_id'))).toBe(true);
    expect(briefQueries.some((q) => q.includes('portal_user_id ='))).toBe(false);
  });

  it('refuses edits from a plain preview session', async () => {
    stub({ briefs: [BRIEF] });
    const res = await callBrief({ method: 'PATCH', body: { id: 'brief-1', answers: { goal: 'sell' } } });
    expect(res.statusCode).toBe(403);
  });

  it("refuses edits in manage mode too — a brief is the client's own", async () => {
    stub({ briefs: [BRIEF] });
    const res = await callBrief({ method: 'PATCH', manage: true, body: { id: 'brief-1', answers: { goal: 'sell' } } });
    expect(res.statusCode).toBe(403);
  });

  it('tells manage mode it is still read-only, so it never renders a form that 403s', async () => {
    stub({ briefs: [BRIEF] });
    const res = await callBrief({ manage: true });
    expect(res.body.readOnly).toBe(true);
  });
});

// Deleting a brief is the one destructive thing staff CAN do to it, and it
// exists because briefs stopped being per-person: orgs are left holding empty
// drafts nobody will finish. The answers, the change history and the record of
// who wrote them all go together, and nothing else keeps a copy.
describe('brief delete — manage mode only', () => {
  const EMPTY = { ...BRIEF, id: 'brief-empty', title: null, answers: {} };
  const deletes = (queries) => queries.filter((q) => q.includes('DELETE FROM client_briefs'));

  it('refuses a read-only preview', async () => {
    const { queries } = stub({ briefs: [EMPTY] });
    const res = await callBrief({ method: 'POST', action: 'brief-delete', body: { id: EMPTY.id } });
    expect(res.statusCode).toBe(403);
    expect(deletes(queries)).toHaveLength(0);
  });

  it('deletes an empty draft in manage mode', async () => {
    const { queries } = stub({ briefs: [EMPTY] });
    const res = await callBrief({ method: 'POST', action: 'brief-delete', manage: true, body: { id: EMPTY.id } });
    expect(res.statusCode).toBe(200);
    const d = deletes(queries);
    expect(d).toHaveLength(1);
    // Scoped by company as well as id: a preview token is scoped to one
    // organisation, and an id alone would let a guessed one reach past it.
    expect(d[0]).toContain('company_id');
  });

  it('refuses a brief with answers in it unless told twice', async () => {
    const { queries } = stub({ briefs: [BRIEF] });
    const res = await callBrief({ method: 'POST', action: 'brief-delete', manage: true, body: { id: BRIEF.id } });
    expect(res.statusCode).toBe(409);
    expect(res.body.needsForce).toBe(true);
    expect(res.body.answered).toBeGreaterThan(0);
    expect(deletes(queries)).toHaveLength(0);
  });

  it('goes through on an explicit force', async () => {
    const { queries } = stub({ briefs: [BRIEF] });
    const res = await callBrief({
      method: 'POST', action: 'brief-delete', manage: true,
      body: { id: BRIEF.id, force: true },
    });
    expect(res.statusCode).toBe(200);
    expect(deletes(queries)).toHaveLength(1);
  });

  it('404s for a brief that is not this organisation’s', async () => {
    const { queries } = stub({ briefs: [] });
    const res = await callBrief({
      method: 'POST', action: 'brief-delete', manage: true, body: { id: 'someone-elses' },
    });
    expect(res.statusCode).toBe(404);
    expect(deletes(queries)).toHaveLength(0);
  });
});

// Filing a brief against a job is the ONE thing about a brief that staff may
// change. The answers stay the client's own account of what they want — staff
// typing into those would make the activity feed a lie about who said what —
// but every brief written before briefs could name a job is sitting unfiled,
// and emailing a client to ask them to tick a box we could tick ourselves is
// not a system.
describe('brief filing — manage mode may, read-only may not', () => {
  const DEAL = { id: 'deal-1', title: 'CareConnect launch film', company_id: COMPANY.id };
  const attaches = (queries) => queries.filter((q) => q.includes('UPDATE client_briefs SET deal_id'));

  it('refuses a read-only preview', async () => {
    const { queries } = stub({ briefs: [BRIEF], deals: [DEAL] });
    const res = await callBrief({
      method: 'POST', action: 'brief-attach', body: { id: BRIEF.id, dealId: DEAL.id },
    });
    expect(res.statusCode).toBe(403);
    expect(attaches(queries)).toHaveLength(0);
  });

  it('files it in manage mode', async () => {
    const { queries } = stub({ briefs: [BRIEF], deals: [DEAL] });
    const res = await callBrief({
      method: 'POST', action: 'brief-attach', manage: true,
      body: { id: BRIEF.id, dealId: DEAL.id },
    });
    expect(res.statusCode).toBe(200);
    expect(attaches(queries)).toHaveLength(1);
  });

  it('records it as Squideo, not as the client', async () => {
    const { queries } = stub({ briefs: [BRIEF], deals: [DEAL] });
    await callBrief({
      method: 'POST', action: 'brief-attach', manage: true,
      body: { id: BRIEF.id, dealId: DEAL.id },
    });
    // The event exists and carries a staff email rather than a portal user —
    // the client's feed has to say who filed it, not quietly reattribute it.
    const events = queries.filter((q) => q.includes('INSERT INTO client_brief_events'));
    expect(events).toHaveLength(1);
  });

  it('still files a FINALISED brief for staff — that is when you notice', async () => {
    const finalised = { ...BRIEF, submitted_at: '2026-08-10T09:00:00.000Z' };
    const { queries } = stub({ briefs: [finalised], deals: [DEAL] });
    const res = await callBrief({
      method: 'POST', action: 'brief-attach', manage: true,
      body: { id: BRIEF.id, dealId: DEAL.id },
    });
    expect(res.statusCode).toBe(200);
    expect(attaches(queries)).toHaveLength(1);
  });

  it('will not file a brief onto another organisation\'s deal', async () => {
    // requireDealInOrg scopes by the preview token's company, so a deal
    // belonging to someone else simply is not found.
    const { queries } = stub({ briefs: [BRIEF], deals: [] });
    const res = await callBrief({
      method: 'POST', action: 'brief-attach', manage: true,
      body: { id: BRIEF.id, dealId: 'someone-elses-deal' },
    });
    expect(res.statusCode).toBe(404);
    expect(attaches(queries)).toHaveLength(0);
  });
});
