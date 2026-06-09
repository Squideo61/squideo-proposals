import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/auth.js', () => ({
  verifyToken: vi.fn(),
}));
vi.mock('../api/_lib/extension.js', () => ({
  lookupExtensionToken: vi.fn(),
}));
vi.mock('../api/_lib/userRoles.js', () => ({
  getRole: vi.fn(),
}));
vi.mock('../api/_lib/sessions.js', () => ({
  getTokenVersion: vi.fn(),
}));

import { requireAuth, requireAdmin, requirePermission } from '../api/_lib/middleware.js';
import { verifyToken } from '../api/_lib/auth.js';
import { lookupExtensionToken } from '../api/_lib/extension.js';
import { getRole } from '../api/_lib/userRoles.js';
import { getTokenVersion } from '../api/_lib/sessions.js';

function fakeReq(headers = {}) {
  return { headers };
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader() {},
  };
}

beforeEach(() => {
  vi.mocked(verifyToken).mockReset();
  vi.mocked(lookupExtensionToken).mockReset();
  vi.mocked(getRole).mockReset();
  vi.mocked(getTokenVersion).mockReset();
  // Default: the token's version matches the stored one (session is live).
  vi.mocked(getTokenVersion).mockResolvedValue(1);
});

describe('requireAuth', () => {
  it('401s when the Authorization header is missing', async () => {
    const res = fakeRes();
    const r = await requireAuth(fakeReq({}), res);
    expect(r).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorised' });
  });

  it('401s when the Authorization header is not a Bearer token', async () => {
    const res = fakeRes();
    const r = await requireAuth(fakeReq({ authorization: 'Basic abc' }), res);
    expect(r).toBeNull();
    expect(res.statusCode).toBe(401);
  });

  it('returns the JWT payload when verifyToken succeeds and the version matches', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ email: 'a@x.com', role: 'admin', tv: 1 });
    const res = fakeRes();
    const r = await requireAuth(fakeReq({ authorization: 'Bearer jwt' }), res);
    expect(r).toEqual({ email: 'a@x.com', role: 'admin', tv: 1 });
    expect(res.statusCode).toBeNull();
    expect(lookupExtensionToken).not.toHaveBeenCalled();
  });

  it('401s ("Session expired") when the token version no longer matches', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ email: 'a@x.com', role: 'admin', tv: 1 });
    vi.mocked(getTokenVersion).mockResolvedValueOnce(2); // user bumped their version
    const res = fakeRes();
    const r = await requireAuth(fakeReq({ authorization: 'Bearer jwt' }), res);
    expect(r).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Session expired' });
    expect(lookupExtensionToken).not.toHaveBeenCalled();
  });

  it('401s a token with no version claim (issued before revocation support)', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ email: 'a@x.com', role: 'admin' });
    vi.mocked(getTokenVersion).mockResolvedValueOnce(0);
    const res = fakeRes();
    const r = await requireAuth(fakeReq({ authorization: 'Bearer jwt' }), res);
    expect(r).toBeNull();
    expect(res.statusCode).toBe(401);
  });

  it('401s ("Invalid token") when the user no longer exists', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ email: 'gone@x.com', role: 'admin', tv: 1 });
    vi.mocked(getTokenVersion).mockResolvedValueOnce(null);
    const res = fakeRes();
    const r = await requireAuth(fakeReq({ authorization: 'Bearer jwt' }), res);
    expect(r).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid token' });
  });

  it('allows on a valid signature when the version lookup errors (fail open)', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ email: 'a@x.com', role: 'admin', tv: 1 });
    vi.mocked(getTokenVersion).mockRejectedValueOnce(new Error('db down'));
    const res = fakeRes();
    const r = await requireAuth(fakeReq({ authorization: 'Bearer jwt' }), res);
    expect(r).toMatchObject({ email: 'a@x.com' });
    expect(res.statusCode).toBeNull();
  });

  it('falls back to extension-token lookup when verifyToken throws', async () => {
    vi.mocked(verifyToken).mockRejectedValueOnce(new Error('bad jwt'));
    vi.mocked(lookupExtensionToken).mockResolvedValueOnce({
      email: 'b@x.com',
      role: 'member',
      via: 'extension-token',
    });
    const res = fakeRes();
    const r = await requireAuth(fakeReq({ authorization: 'Bearer ext_xyz' }), res);
    expect(r).toMatchObject({ email: 'b@x.com', via: 'extension-token' });
    expect(res.statusCode).toBeNull();
  });

  it('401s when both JWT verify and extension lookup fail to produce a payload', async () => {
    vi.mocked(verifyToken).mockRejectedValueOnce(new Error('bad jwt'));
    vi.mocked(lookupExtensionToken).mockResolvedValueOnce(null);
    const res = fakeRes();
    const r = await requireAuth(fakeReq({ authorization: 'Bearer nope' }), res);
    expect(r).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid token' });
  });

  it('still 401s (instead of crashing) when the extension-token lookup throws', async () => {
    vi.mocked(verifyToken).mockRejectedValueOnce(new Error('bad jwt'));
    vi.mocked(lookupExtensionToken).mockRejectedValueOnce(new Error('db down'));
    const res = fakeRes();
    const r = await requireAuth(fakeReq({ authorization: 'Bearer nope' }), res);
    expect(r).toBeNull();
    expect(res.statusCode).toBe(401);
  });

  it('strips the "Bearer " prefix before passing the token onward', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ email: 'a@x.com', role: 'admin', tv: 1 });
    const res = fakeRes();
    await requireAuth(fakeReq({ authorization: 'Bearer the-token' }), res);
    expect(vi.mocked(verifyToken)).toHaveBeenCalledWith('the-token');
  });
});

describe('requireAdmin', () => {
  it('returns the payload (with permissions) when role grants users.manage', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ email: 'a@x.com', role: 'admin', tv: 1 });
    vi.mocked(getRole).mockResolvedValueOnce({ id: 'admin', permissions: ['*'] });
    const res = fakeRes();
    const r = await requireAdmin(fakeReq({ authorization: 'Bearer j' }), res);
    expect(r).toMatchObject({ role: 'admin', permissions: ['*'] });
    expect(res.statusCode).toBeNull();
  });

  it('403s when the role does not grant users.manage', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ email: 'a@x.com', role: 'member', tv: 1 });
    vi.mocked(getRole).mockResolvedValueOnce({ id: 'member', permissions: [] });
    const res = fakeRes();
    const r = await requireAdmin(fakeReq({ authorization: 'Bearer j' }), res);
    expect(r).toBeNull();
    expect(res.statusCode).toBe(403);
  });

  it('propagates the 401 when requireAuth fails (no extra 403)', async () => {
    const res = fakeRes();
    const r = await requireAdmin(fakeReq({}), res);
    expect(r).toBeNull();
    expect(res.statusCode).toBe(401);
  });
});

describe('requirePermission', () => {
  it('grants when the role contains the slug', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ email: 'a@x.com', role: 'sm', tv: 1 });
    vi.mocked(getRole).mockResolvedValueOnce({ id: 'sm', permissions: ['deals.manage_all'] });
    const res = fakeRes();
    const r = await requirePermission(fakeReq({ authorization: 'Bearer j' }), res, 'deals.manage_all');
    expect(r).toMatchObject({ permissions: ['deals.manage_all'] });
  });

  it('grants when the role has the wildcard', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ email: 'a@x.com', role: 'admin', tv: 1 });
    vi.mocked(getRole).mockResolvedValueOnce({ id: 'admin', permissions: ['*'] });
    const res = fakeRes();
    const r = await requirePermission(fakeReq({ authorization: 'Bearer j' }), res, 'anything.you.like');
    expect(r).toMatchObject({ permissions: ['*'] });
  });

  it('grants when any-of an array of slugs matches', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ email: 'a@x.com', role: 'sm', tv: 1 });
    vi.mocked(getRole).mockResolvedValueOnce({ id: 'sm', permissions: ['deals.manage_all'] });
    const res = fakeRes();
    const r = await requirePermission(fakeReq({ authorization: 'Bearer j' }), res,
      ['users.manage', 'deals.manage_all']);
    expect(r).toMatchObject({ permissions: ['deals.manage_all'] });
  });

  it('403s when no slug in the array matches', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ email: 'a@x.com', role: 'm', tv: 1 });
    vi.mocked(getRole).mockResolvedValueOnce({ id: 'm', permissions: [] });
    const res = fakeRes();
    const r = await requirePermission(fakeReq({ authorization: 'Bearer j' }), res,
      ['users.manage', 'roles.manage']);
    expect(r).toBeNull();
    expect(res.statusCode).toBe(403);
  });

  it('403s when getRole returns null (orphaned role id)', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ email: 'a@x.com', role: 'deleted', tv: 1 });
    vi.mocked(getRole).mockResolvedValueOnce(null);
    const res = fakeRes();
    const r = await requirePermission(fakeReq({ authorization: 'Bearer j' }), res, 'users.manage');
    expect(r).toBeNull();
    expect(res.statusCode).toBe(403);
  });
});
