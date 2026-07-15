// The client's own logo, for portal chrome and portal emails.
//
// There is no logo column anywhere in the schema: the only place a customer's
// brand mark exists is the proposal we built for them, as a base64 data URL in
// proposals.data->>'clientLogo' (set by the builder's LogoUploader). An org's
// logo is therefore the newest one across that org's proposals, resolved on
// read so it follows whatever their latest proposal shows.
//
// It's exposed as an <img src> pointing at /api/portal-logo rather than as the
// data URL itself: email clients (Gmail's image proxy especially) won't render
// a data: URI, and inlining a few hundred KB of base64 into every session
// payload would be wasteful.

import sql from '../db.js';
import { APP_URL } from '../email.js';

// Same-origin path — for the portal SPA.
export function portalLogoPath(companyId) {
  return `/api/portal-logo?c=${encodeURIComponent(companyId)}`;
}

// Absolute URL — for emails, which are read outside our origin.
export function portalLogoUrl(companyId) {
  return `${APP_URL.replace(/\/$/, '')}${portalLogoPath(companyId)}`;
}

export async function companyHasLogo(companyId) {
  if (!companyId) return false;
  const rows = await sql`
    SELECT 1
      FROM proposals p
      JOIN deals d ON d.id = p.deal_id
     WHERE d.company_id = ${companyId}
       AND COALESCE(p.data->>'clientLogo', '') <> ''
     LIMIT 1
  `;
  return rows.length > 0;
}

// The absolute logo URL for an email, or null when the client has no logo —
// callers pass this straight into the portal email templates.
export async function emailLogoUrl(companyId) {
  if (!companyId) return null;
  return (await companyHasLogo(companyId)) ? portalLogoUrl(companyId) : null;
}

export async function companyLogoDataUrl(companyId) {
  if (!companyId) return null;
  const rows = await sql`
    SELECT p.data->>'clientLogo' AS logo
      FROM proposals p
      JOIN deals d ON d.id = p.deal_id
     WHERE d.company_id = ${companyId}
       AND COALESCE(p.data->>'clientLogo', '') <> ''
     ORDER BY p.updated_at DESC NULLS LAST, p.created_at DESC
     LIMIT 1
  `;
  return rows[0]?.logo || null;
}

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i;

// data:image/png;base64,… → raw bytes. Anything that isn't a base64 image data
// URL (an http link pasted in by hand, a malformed value) returns null.
export function decodeLogo(dataUrl) {
  const m = DATA_URL.exec(String(dataUrl || '').trim());
  if (!m) return null;
  const bytes = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!bytes.length) return null;
  return { contentType: m[1].toLowerCase(), bytes };
}
