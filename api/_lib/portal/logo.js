// The client's own logo, for portal chrome and portal emails.
//
// Two sources, in precedence order:
//   1. companies.logo — uploaded once on the organisation in the CRM. This is
//      the one that follows the client: it pre-fills every new proposal and is
//      what their portal shows.
//   2. proposals.data->>'clientLogo' — the original home (a base64 data URL set
//      by the builder's LogoUploader), kept as the fallback so every client who
//      had a logo before this feature still has one, without a backfill.
//
// It's exposed as an <img src> pointing at /api/portal-logo rather than as the
// data URL itself: email clients (Gmail's image proxy especially) won't render
// a data: URI, and inlining a few hundred KB of base64 into every session
// payload would be wasteful.

import sql from '../db.js';
import { APP_URL } from '../email.js';

// Runtime self-heal for db/migrations/20260730_company_logo.sql. Module-cached;
// on failure the cache is reset so a later call can retry.
let logoColumnsEnsured = null;
export function ensureCompanyLogoColumns() {
  if (logoColumnsEnsured) return logoColumnsEnsured;
  logoColumnsEnsured = (async () => {
    await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo TEXT`;
    await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_updated_at TIMESTAMPTZ`;
    await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_updated_by TEXT`;
  })().catch((err) => { logoColumnsEnsured = null; throw err; });
  return logoColumnsEnsured;
}

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
  await ensureCompanyLogoColumns().catch(() => {});
  const rows = await sql`
    SELECT 1 FROM companies WHERE id = ${companyId} AND logo IS NOT NULL LIMIT 1
  `.catch(() => []);
  if (rows.length) return true;
  const fallback = await sql`
    SELECT 1
      FROM proposals p
      JOIN deals d ON d.id = p.deal_id
     WHERE d.company_id = ${companyId}
       AND COALESCE(p.data->>'clientLogo', '') <> ''
     LIMIT 1
  `;
  return fallback.length > 0;
}

// The absolute logo URL for an email, or null when the client has no logo —
// callers pass this straight into the portal email templates.
export async function emailLogoUrl(companyId) {
  if (!companyId) return null;
  return (await companyHasLogo(companyId)) ? portalLogoUrl(companyId) : null;
}

export async function companyLogoDataUrl(companyId) {
  if (!companyId) return null;
  await ensureCompanyLogoColumns().catch(() => {});
  const own = await sql`SELECT logo FROM companies WHERE id = ${companyId}`.catch(() => []);
  if (own[0]?.logo) return own[0].logo;
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
