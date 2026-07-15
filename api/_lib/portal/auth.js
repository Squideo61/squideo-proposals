// Portal session tokens + one-time token helpers. The portal is a fully
// separate auth surface from the staff CRM: its JWT carries aud='portal-session'
// (which the staff verifyToken in api/_lib/auth.js explicitly rejects) and it
// travels in its own HttpOnly cookie (sq_portal), so neither token can be
// replayed against the other surface.

import crypto from 'crypto';
import { SignJWT, jwtVerify } from 'jose';

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET);

export const PORTAL_SESSION_AUD = 'portal-session';

const PORTAL_COOKIE = 'sq_portal';
// Match the JWT lifetime below (30d).
const PORTAL_MAX_AGE = 60 * 60 * 24 * 30;

export async function signPortalToken({ puid, email, tv }) {
  return new SignJWT({ puid, email, tv })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(PORTAL_SESSION_AUD)
    .setExpirationTime('30d')
    .sign(await secret());
}

export async function verifyPortalToken(token) {
  const { payload } = await jwtVerify(token, await secret(), { audience: PORTAL_SESSION_AUD });
  return payload;
}

// Staff "preview as this client" token. Same portal audience so it flows through
// requirePortalAuth, but carries `pv:true` + the org it's scoped to and no puid —
// requirePortalAuth turns it into a synthetic, READ-ONLY session for that one
// organisation. Short-lived; delivered in a URL and held per-tab (never a
// cookie), so it can't collide with a real client's login in the same browser.
export async function signPortalPreviewToken({ companyId, staffEmail }) {
  return new SignJWT({ pv: true, companyId, staffEmail })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(PORTAL_SESSION_AUD)
    .setExpirationTime('2h')
    .sign(await secret());
}

// Read the per-tab preview token the SPA sends as a header (see src/portal/api.js).
export function readPreviewHeader(req) {
  const h = req.headers['x-portal-preview'];
  return (Array.isArray(h) ? h[0] : h) || null;
}

export function portalCookieHeader(jwt) {
  return `${PORTAL_COOKIE}=${jwt}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${PORTAL_MAX_AGE}`;
}

export function clearPortalCookieHeader() {
  return `${PORTAL_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function readPortalCookie(cookieHeader) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === PORTAL_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

// One-time tokens (invites, magic links, password resets). The raw token goes
// in the email link; only its SHA-256 hash is stored, so a DB read can never
// yield a usable credential.
export function createRawToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}
