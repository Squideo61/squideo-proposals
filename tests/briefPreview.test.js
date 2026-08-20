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
function stub({ briefs = [] } = {}) {
  const inserted = [];
  const queries = [];
  setSqlHandler((text) => {
    queries.push(text);
    if (text.includes('INSERT INTO client_briefs')) { inserted.push(text); return []; }
    if (text.includes('FROM companies WHERE id')) return [COMPANY];
    if (text.includes('SELECT c.logo_updated_at FROM companies c')) return [];
    if (text.includes('FROM client_briefs')) return briefs;
    return [];
  });
  return { inserted, queries };
}

async function callBrief({ method = 'GET', manage = false, body = undefined }) {
  const token = await signPortalPreviewToken({
    companyId: COMPANY.id, staffEmail: 'adam@squideo.co.uk', manage,
  });
  const res = fakeRes();
  await handler({
    method,
    query: { action: 'brief' },
    headers: { 'x-portal-preview': token, 'content-type': 'application/json' },
    body,
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
