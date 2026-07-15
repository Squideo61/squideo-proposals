// Auth middleware for the customer portal API. Mirrors the staff pattern in
// api/_lib/middleware.js: HttpOnly cookie → JWT verify (portal audience) →
// liveness checks (disabled_at, token_version) → active org memberships.
//
// Every data query in api/portal/* MUST be scoped through the caller's
// membership company ids — use resolveCompanyId / assertDealInOrg below.

import sql from '../db.js';
import { ensurePortalTables } from './db.js';
import { verifyPortalToken, readPortalCookie } from './auth.js';
import { portalLogoPath } from './logo.js';

export async function requirePortalAuth(req, res) {
  const token = readPortalCookie(req.headers.cookie);
  if (!token) {
    res.status(401).json({ error: 'Unauthorised' });
    return null;
  }
  let payload;
  try {
    payload = await verifyPortalToken(token);
  } catch {
    res.status(401).json({ error: 'Session expired' });
    return null;
  }
  await ensurePortalTables();
  const rows = await sql`
    SELECT id, email, name, phone, job_title, token_version, disabled_at, contact_id
      FROM portal_users WHERE id = ${payload.puid}
  `;
  const u = rows[0];
  if (!u || u.disabled_at) {
    res.status(401).json({ error: 'Account unavailable' });
    return null;
  }
  const claimedTv = Number.isInteger(payload.tv) ? payload.tv : -1;
  if (claimedTv !== (u.token_version ?? 0)) {
    res.status(401).json({ error: 'Session expired' });
    return null;
  }
  // has_logo rides along here rather than in its own round trip: the portal
  // chrome renders the client's logo on every page, so the session payload is
  // where it belongs.
  const memberships = await sql`
    SELECT m.company_id, c.name AS company_name,
           EXISTS (
             SELECT 1 FROM proposals p
               JOIN deals d ON d.id = p.deal_id
              WHERE d.company_id = m.company_id
                AND COALESCE(p.data->>'clientLogo', '') <> ''
           ) AS has_logo
      FROM portal_memberships m
      JOIN companies c ON c.id = m.company_id
     WHERE m.portal_user_id = ${u.id} AND m.disabled_at IS NULL
     ORDER BY m.created_at ASC
  `;
  if (!memberships.length) {
    res.status(403).json({ error: 'No active organisation membership' });
    return null;
  }
  return {
    puid: u.id,
    email: u.email,
    name: u.name,
    phone: u.phone,
    jobTitle: u.job_title,
    contactId: u.contact_id,
    companyIds: memberships.map((m) => m.company_id),
    companies: memberships.map((m) => ({
      id: m.company_id,
      name: m.company_name,
      logoUrl: m.has_logo ? portalLogoPath(m.company_id) : null,
    })),
  };
}

// Resolve the org a request operates on: an explicit ?companyId= must be one
// of the caller's memberships; with no param, a single-org user defaults to
// their only org. Sends the error response itself and returns null on failure.
export function resolveCompanyId(req, res, portalUser) {
  const requested = req.query.companyId ? String(req.query.companyId) : null;
  if (requested) {
    if (!portalUser.companyIds.includes(requested)) {
      res.status(403).json({ error: 'Not a member of this organisation' });
      return null;
    }
    return requested;
  }
  if (portalUser.companyIds.length === 1) return portalUser.companyIds[0];
  res.status(400).json({ error: 'companyId required' });
  return null;
}

// A deal is in-org when its company_id is one of the caller's memberships.
// Returns the deal row (portal-relevant columns) or null after sending 404 —
// a cross-org probe gets the same 404 as a nonexistent id (no existence oracle).
export async function requireDealInOrg(res, dealId, companyIds) {
  if (!dealId) {
    res.status(400).json({ error: 'dealId required' });
    return null;
  }
  const rows = await sql`
    SELECT d.id, d.title, d.company_id, d.stage, d.value, d.vat_rate, d.payment_terms,
           d.production_phase, d.production_stage, d.production_entered_at,
           d.po_number, d.drive_folder_id, d.revision_project_id,
           d.portal_extras_discount, d.delivery_deadline, d.created_at,
           c.name AS company_name
      FROM deals d
      JOIN companies c ON c.id = d.company_id
     WHERE d.id = ${dealId} AND d.company_id = ANY(${companyIds})
  `;
  if (!rows.length) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  return rows[0];
}

export function clientIp(req) {
  return ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()
       || req.headers['x-real-ip']
       || 'unknown');
}
