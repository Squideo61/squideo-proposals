// Staff previewing a client's portal used to CRASH on the Brief Builder: the
// GET lazily creates a draft, and portal_user_id is NOT NULL while a preview
// session has no puid. So the one screen a staff member would open to check a
// client's brief was the one screen that 500'd.
//
// Preview now reads the ORGANISATION's brief instead of "its own", creates
// nothing, and refuses writes — including in manage mode, because a brief is
// the client's own account of what they want.
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
  answers: { projectName: 'Recruitment film', goal: 'awareness' },
  completed_at: null,
  submitted_at: null,
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
function stub({ openBrief = null } = {}) {
  const inserted = [];
  setSqlHandler((text) => {
    if (text.includes('INSERT INTO client_briefs')) { inserted.push(text); return []; }
    if (text.includes('FROM companies WHERE id')) return [COMPANY];
    if (text.includes('SELECT c.logo_updated_at FROM companies c')) return [];
    if (text.includes('FROM client_briefs') && text.includes('submitted_at IS NULL')) {
      return openBrief ? [openBrief] : [];
    }
    if (text.includes('FROM client_briefs')) return [];
    return [];
  });
  return inserted;
}

async function callBrief({ method = 'GET', manage = false }) {
  const token = await signPortalPreviewToken({
    companyId: COMPANY.id, staffEmail: 'adam@squideo.co.uk', manage,
  });
  const res = fakeRes();
  await handler({
    method,
    query: { action: 'brief' },
    headers: { 'x-portal-preview': token },
  }, res);
  return res;
}

beforeEach(() => { resetSqlMock(); });

describe('brief builder — staff preview', () => {
  it('does not create a brief row for a session with no portal user', async () => {
    const inserted = stub();
    const res = await callBrief({});
    expect(inserted).toHaveLength(0);
    expect(res.statusCode).toBe(200);
    expect(res.body.brief).toBeNull();
    expect(res.body.readOnly).toBe(true);
  });

  it("shows the organisation's open brief rather than nothing", async () => {
    stub({ openBrief: BRIEF });
    const res = await callBrief({});
    expect(res.statusCode).toBe(200);
    expect(res.body.readOnly).toBe(true);
    expect(res.body.brief.answers.projectName).toBe('Recruitment film');
  });

  it('refuses edits from a plain preview session', async () => {
    stub({ openBrief: BRIEF });
    const res = await callBrief({ method: 'PATCH' });
    expect(res.statusCode).toBe(403);
  });

  it('refuses edits in manage mode too — a brief is the client\'s own', async () => {
    stub({ openBrief: BRIEF });
    const res = await callBrief({ method: 'PATCH', manage: true });
    expect(res.statusCode).toBe(403);
  });
});
