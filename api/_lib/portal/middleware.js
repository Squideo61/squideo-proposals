// Auth middleware for the customer portal API. Mirrors the staff pattern in
// api/_lib/middleware.js: HttpOnly cookie → JWT verify (portal audience) →
// liveness checks (disabled_at, token_version) → active org memberships.
//
// Every data query in api/portal/* MUST be scoped through the caller's
// membership company ids — use resolveCompanyId / assertDealInOrg below.

import sql from '../db.js';
import { ensurePortalTables } from './db.js';
import { verifyPortalToken, readPortalCookie, readPreviewHeader } from './auth.js';
import { portalLogoPath } from './logo.js';
import { creditVisibleFor, hasProjectFor } from '../crm/companyCredit.js';

// Cache key for the logo URL: null when the org has never had one uploaded (a
// proposal-derived fallback logo doesn't change, so it needs no version).
function logoVersion(updatedAt) {
  if (!updatedAt) return null;
  const t = new Date(updatedAt).getTime();
  return Number.isFinite(t) ? String(t) : null;
}

export async function requirePortalAuth(req, res) {
  // Staff "preview as client" comes in as a per-tab header (never a cookie, so
  // it can't hijack a real client session). It yields a synthetic session scoped
  // to the one organisation being previewed — read-only by default (writes are
  // blocked in the router by the `isPreview` flag), or writable when the token
  // carries the `manage` claim ("manage mode").
  const previewToken = readPreviewHeader(req);
  if (previewToken) {
    let pv;
    try {
      pv = await verifyPortalToken(previewToken);
    } catch {
      res.status(401).json({ error: 'Preview link expired — reopen the preview from the CRM.' });
      return null;
    }
    if (!pv?.pv || !pv.companyId) {
      res.status(401).json({ error: 'Invalid preview session' });
      return null;
    }
    await ensurePortalTables();
    const [co] = await sql`
      SELECT id, name, COALESCE(prospect, FALSE) AS prospect, credit_enabled
        FROM companies WHERE id = ${pv.companyId}`;
    if (!co) {
      res.status(404).json({ error: 'Organisation not found' });
      return null;
    }
    // The org's own uploaded logo wins; a proposal's clientLogo is the fallback
    // (see api/_lib/portal/logo.js for the precedence).
    const [logo] = await sql`
      SELECT c.logo_updated_at FROM companies c
       WHERE c.id = ${co.id}
         AND (c.logo IS NOT NULL OR EXISTS (
           SELECT 1 FROM proposals p JOIN deals d ON d.id = p.deal_id
            WHERE d.company_id = c.id AND COALESCE(p.data->>'clientLogo', '') <> ''
         ))
       LIMIT 1
    `;
    const previewHasProject = (await hasProjectFor([co.id])).has(co.id);
    return {
      puid: null,
      isPreview: true,
      canManage: pv.manage === true,
      previewBy: pv.staffEmail || null,
      email: pv.staffEmail || 'preview@squideo.co.uk',
      name: pv.manage === true ? (pv.staffEmail || 'Squideo') : 'Preview',
      companyIds: [co.id],
      // Staff previewing a prospect's portal must see what the prospect sees,
      // rate card included — otherwise the preview stops being a preview.
      companies: [{
        id: co.id, name: co.name, prospect: co.prospect === true,
        creditVisible: creditVisibleFor({
          creditEnabled: co.credit_enabled, prospect: co.prospect, hasProject: previewHasProject,
        }),
        logoUrl: logo ? portalLogoPath(co.id, logoVersion(logo.logo_updated_at)) : null,
      }],
    };
  }

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
    SELECT m.company_id, c.name AS company_name, c.logo_updated_at,
           COALESCE(c.prospect, FALSE) AS prospect,
           c.credit_enabled,
           (c.logo IS NOT NULL OR EXISTS (
             SELECT 1 FROM proposals p
               JOIN deals d ON d.id = p.deal_id
              WHERE d.company_id = m.company_id
                AND COALESCE(p.data->>'clientLogo', '') <> ''
           )) AS has_logo
      FROM portal_memberships m
      JOIN companies c ON c.id = m.company_id
     WHERE m.portal_user_id = ${u.id} AND m.disabled_at IS NULL
     ORDER BY m.created_at ASC
  `;
  if (!memberships.length) {
    res.status(403).json({ error: 'No active organisation membership' });
    return null;
  }
  // Which of their orgs are clients rather than prospects — a deal in
  // production, or credit already bought. Its own round trip rather than a
  // subquery on the join above, so that a schema surprise degrades to "no
  // project" (recoverable with the staff override) instead of 500ing every
  // portal request. Only the rate card reads it.
  const clientOrgs = await hasProjectFor(memberships.map((m) => m.company_id));
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
      logoUrl: m.has_logo ? portalLogoPath(m.company_id, logoVersion(m.logo_updated_at)) : null,
      // A video-guide signup gets a portal account and a `prospect` org, but
      // isn't a client. The portal uses this to decide what the rate card is
      // shown to: publishing £/min to someone we haven't scoped anything for
      // anchors every quote we send them afterwards.
      prospect: m.prospect === true,
      // Resolved once, here, so the nav, the API guard and the CRM label can't
      // disagree. See creditVisibleFor() for the rule and the tri-state.
      creditVisible: creditVisibleFor({
        creditEnabled: m.credit_enabled,
        prospect: m.prospect,
        hasProject: clientOrgs.has(m.company_id),
      }),
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
           d.po_number, d.drive_folder_id, d.revision_project_id, d.reference,
           d.client_tasks_launched_at, d.script_status, d.script_status_at,
           d.portal_extras_discount, d.delivery_deadline, d.created_at,
           -- The project-wide schedule. Videos carry their own; this is what a
           -- single-video project scheduled from the deal page has instead.
           d.production_schedule,
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
