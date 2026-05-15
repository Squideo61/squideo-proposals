// Error-response contract for the JSON API surface:
//
//   { error: string, code?: string }
//
// `error` is the human-readable message the frontend renders (src/api.js
// reads this key, falling back to "Request failed"). `code` is optional and
// only used where the caller needs to programmatically distinguish reasons
// — e.g. the Gmail send route returns `code: 'gmail-not-connected'`.
//
// Browser-targeted OAuth callbacks (api/xero connect/callback) intentionally
// respond with text/HTML because they're hit by a redirect, not an XHR.

import { verifyToken } from './auth.js';
import { lookupExtensionToken } from './extension.js';
import { getRole } from './userRoles.js';
import { hasPermission } from './permissions.js';

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Filename');
}

const SESSION_COOKIE = 'sq_session';
// Match the JWT lifetime configured in api/_lib/auth.js (30d).
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

export function sessionCookieHeader(jwt) {
  return `${SESSION_COOKIE}=${jwt}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// Append one or more Set-Cookie strings without trampling whatever an earlier
// step already wrote (e.g. issueTrustedDevice setting sq_td before we set
// sq_session here). Node/Vercel accepts an array for multiple Set-Cookie lines.
export function appendSetCookie(res, ...cookies) {
  const next = cookies.filter(Boolean);
  if (!next.length) return;
  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', next.length === 1 ? next[0] : next);
  else if (Array.isArray(existing)) res.setHeader('Set-Cookie', [...existing, ...next]);
  else res.setHeader('Set-Cookie', [existing, ...next]);
}

function readSessionCookie(cookieHeader) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export async function requireAuth(req, res) {
  // Prefer the HttpOnly session cookie set on web login. The Chrome extension
  // runs cross-origin and cannot read or send our cookie, so it continues to
  // pass its opaque token in the Authorization header.
  const cookieJwt = readSessionCookie(req.headers.cookie);
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = cookieJwt || bearer;
  if (!token) {
    res.status(401).json({ error: 'Unauthorised' });
    return null;
  }
  // 1. Try as a session JWT (the normal web-app path).
  try {
    return await verifyToken(token);
  } catch { /* fall through */ }
  // 2. Fall back to a stored extension token. Adds one DB query but only for
  //    callers that don't have a valid JWT; web-app traffic still short-circuits
  //    on the JWT verify above.
  try {
    const ext = await lookupExtensionToken(token);
    if (ext) return ext;
  } catch (err) {
    console.warn('[requireAuth] extension token lookup failed', err.message);
  }
  res.status(401).json({ error: 'Invalid token' });
  return null;
}

// Requires the caller to have a specific permission slug on their role. The
// resolved payload also gets a `permissions` array attached so callers don't
// have to re-fetch.
//
// `slug` accepts a single string ('users.manage') or an array (any one of
// them grants access — useful for endpoints that several roles legitimately
// touch, like the admin section nav).
export async function requirePermission(req, res, slug) {
  const payload = await requireAuth(req, res);
  if (!payload) return null;
  const role = await getRole(payload.role);
  const slugs = Array.isArray(slug) ? slug : [slug];
  const ok = slugs.some(s => hasPermission(role, s));
  if (!ok) {
    res.status(403).json({ error: 'You do not have permission to perform this action' });
    return null;
  }
  return { ...payload, permissions: role?.permissions || [] };
}

// requireAdmin is preserved as a thin alias for `requirePermission('users.manage')`
// so existing call-sites keep working through the rollout. The seeded Admin
// role has '*' and the seeded Member role has nothing, so behaviour is
// identical for the two existing roles.
export async function requireAdmin(req, res) {
  return requirePermission(req, res, 'users.manage');
}
