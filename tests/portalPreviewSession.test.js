// Staff sessions inside a client's portal. Two shapes come out of the same
// token type, so the boundary between them is worth pinning:
//   • Preview  — read-only, what the client sees.
//   • Manage   — the same session with writes enabled.
// The token is signed for real here (jose, no mocks) so a change to either the
// signer or the verifier shows up as a failing test rather than a live 403.
import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.JWT_SECRET = 'test-portal-secret-not-a-real-key';

vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock };
});
vi.mock('../api/_lib/portal/db.js', () => ({
  ensurePortalTables: vi.fn().mockResolvedValue(undefined),
}));

import { setSqlHandler, resetSqlMock } from './helpers/mockDb.js';
import { signPortalPreviewToken, verifyPortalToken } from '../api/_lib/portal/auth.js';
import { requirePortalAuth } from '../api/_lib/portal/middleware.js';

const COMPANY = { id: 'co-1', name: 'The Christie NHS Foundation Trust' };

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader() {},
  };
}

// The company lookup, then the "does this org have a logo" probe.
function stubCompanyQueries({ company = COMPANY, hasLogo = false } = {}) {
  setSqlHandler((text) => {
    if (text.includes('FROM companies WHERE id')) return company ? [company] : [];
    if (text.includes('SELECT 1 FROM companies')) return hasLogo ? [{ '?column?': 1 }] : [];
    return [];
  });
}

async function authWith(token) {
  const res = fakeRes();
  const user = await requirePortalAuth({ headers: { 'x-portal-preview': token }, query: {} }, res);
  return { user, res };
}

beforeEach(() => {
  resetSqlMock();
  stubCompanyQueries();
});

describe('preview tokens', () => {
  it('defaults to no manage claim', async () => {
    const payload = await verifyPortalToken(
      await signPortalPreviewToken({ companyId: COMPANY.id, staffEmail: 'adam@squideo.co.uk' })
    );
    expect(payload.pv).toBe(true);
    expect(payload.manage).toBe(false);
    expect(payload.companyId).toBe(COMPANY.id);
  });

  it('carries the manage claim when asked for', async () => {
    const payload = await verifyPortalToken(
      await signPortalPreviewToken({ companyId: COMPANY.id, staffEmail: 'adam@squideo.co.uk', manage: true })
    );
    expect(payload.manage).toBe(true);
  });
});

describe('requirePortalAuth — staff sessions', () => {
  it('builds a read-only session from a plain preview token', async () => {
    const token = await signPortalPreviewToken({ companyId: COMPANY.id, staffEmail: 'adam@squideo.co.uk' });
    const { user } = await authWith(token);
    expect(user.isPreview).toBe(true);
    expect(user.canManage).toBe(false);
    expect(user.puid).toBeNull();
    expect(user.companyIds).toEqual([COMPANY.id]);
  });

  it('grants writes only when the token says manage', async () => {
    const token = await signPortalPreviewToken({ companyId: COMPANY.id, staffEmail: 'adam@squideo.co.uk', manage: true });
    const { user } = await authWith(token);
    expect(user.canManage).toBe(true);
    // Attribution: manage-mode writes are recorded against the staff member.
    expect(user.previewBy).toBe('adam@squideo.co.uk');
  });

  it('is still scoped to the one previewed organisation in manage mode', async () => {
    const token = await signPortalPreviewToken({ companyId: COMPANY.id, staffEmail: 'adam@squideo.co.uk', manage: true });
    const { user } = await authWith(token);
    expect(user.companyIds).toEqual([COMPANY.id]);
    expect(user.companies).toHaveLength(1);
  });

  it('rejects a token that is not a preview token', async () => {
    // A real client session token has no `pv` claim — it must not be usable as
    // a preview header (that would sidestep the cookie + token_version checks).
    const { signPortalToken } = await import('../api/_lib/portal/auth.js');
    const token = await signPortalToken({ puid: 'pu-1', email: 'client@christie.nhs.uk', tv: 0 });
    const { user, res } = await authWith(token);
    expect(user).toBeNull();
    expect(res.statusCode).toBe(401);
  });

  it('404s when the previewed organisation has gone', async () => {
    stubCompanyQueries({ company: null });
    const token = await signPortalPreviewToken({ companyId: 'co-gone', staffEmail: 'adam@squideo.co.uk' });
    const { user, res } = await authWith(token);
    expect(user).toBeNull();
    expect(res.statusCode).toBe(404);
  });
});
