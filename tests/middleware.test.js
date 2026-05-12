import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/auth.js', () => ({
  verifyToken: vi.fn(),
}));
vi.mock('../api/_lib/extension.js', () => ({
  lookupExtensionToken: vi.fn(),
}));

import { requireAuth, requireAdmin } from '../api/_lib/middleware.js';
import { verifyToken } from '../api/_lib/auth.js';
import { lookupExtensionToken } from '../api/_lib/extension.js';

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

  it('returns the JWT payload when verifyToken succeeds (no extension lookup)', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ email: 'a@x.com', role: 'admin' });
    const res = fakeRes();
    const r = await requireAuth(fakeReq({ authorization: 'Bearer jwt' }), res);
    expect(r).toEqual({ email: 'a@x.com', role: 'admin' });
    expect(res.statusCode).toBeNull();
    expect(lookupExtensionToken).not.toHaveBeenCalled();
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
    vi.mocked(verifyToken).mockResolvedValueOnce({ email: 'a@x.com', role: 'admin' });
    const res = fakeRes();
    await requireAuth(fakeReq({ authorization: 'Bearer the-token' }), res);
    expect(vi.mocked(verifyToken)).toHaveBeenCalledWith('the-token');
  });
});

describe('requireAdmin', () => {
  it('returns the payload when role is admin', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ email: 'a@x.com', role: 'admin' });
    const res = fakeRes();
    const r = await requireAdmin(fakeReq({ authorization: 'Bearer j' }), res);
    expect(r).toMatchObject({ role: 'admin' });
    expect(res.statusCode).toBeNull();
  });

  it('403s when the authenticated user is a member, not an admin', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ email: 'a@x.com', role: 'member' });
    const res = fakeRes();
    const r = await requireAdmin(fakeReq({ authorization: 'Bearer j' }), res);
    expect(r).toBeNull();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Admin access required' });
  });

  it('propagates the 401 when requireAuth fails (no extra 403)', async () => {
    const res = fakeRes();
    const r = await requireAdmin(fakeReq({}), res);
    expect(r).toBeNull();
    expect(res.statusCode).toBe(401);
  });
});
