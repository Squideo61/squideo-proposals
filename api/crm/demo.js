// Admin "demo project" seeder — spins up a self-contained test project so staff
// can walk the whole client journey (portal, in-portal revision review,
// comment/approve, gated download) without a real client or the full sign→pay
// process. Everything hangs off a single marked demo company, so teardown is a
// clean cascade. Admin-only.
//
//   GET  /api/crm/demo                 → { exists, links }
//   POST /api/crm/demo?op=seed         → create (or refresh) the demo, return links
//   POST /api/crm/demo?op=portal-link  → a fresh one-click way INTO the portal
//   POST /api/crm/demo?op=delete       → tear it all down

import { del } from '@vercel/blob';
import { cors, requirePermission } from '../_lib/middleware.js';
import sql from '../_lib/db.js';
import { makeId } from '../_lib/crm/shared.js';
import { enterProduction } from '../_lib/production.js';
import { ensurePortalTables } from '../_lib/portal/db.js';
import { createRawToken, hashToken } from '../_lib/portal/auth.js';
import { createPortalInvite, inviteUrlFor } from '../_lib/portal/onboarding.js';
import { PORTAL_URL } from '../_lib/portal/emails.js';
import { DEMO_COMPANY_NAME, invalidateDemoScope } from '../_lib/crm/demoScope.js';

// The name lives in demoScope.js because Finance uses it to keep this project
// out of every money figure — see the note there.
// The portal lives at <app>/portal — use the same constant every portal email
// uses. (A local `process.env.PORTAL_URL || APP_URL` guess silently degraded to
// the CRM's own origin when PORTAL_URL wasn't set, so every "open the portal"
// link here landed back in the CRM.)
const PORTAL_BASE = PORTAL_URL;
const REVISION_PUBLIC_BASE = process.env.APP_URL || '';
const REVISION_BLOB_TOKEN = process.env.REVISION_BLOB_READ_WRITE_TOKEN || process.env.REVIEW_BLOB_READ_WRITE_TOKEN;

async function findDemoCompany() {
  const [co] = await sql`SELECT id FROM companies WHERE name = ${DEMO_COMPANY_NAME} ORDER BY created_at ASC LIMIT 1`;
  return co?.id || null;
}

// Does this staff email already have a portal account with access to the demo
// org? Decides whether "open the portal" hands back a sign-in link or an invite.
async function demoPortalAccount(email, companyId) {
  if (!email || !companyId) return null;
  const [row] = await sql`
    SELECT pu.id, pu.disabled_at
      FROM portal_users pu
      JOIN portal_memberships m ON m.portal_user_id = pu.id AND m.company_id = ${companyId}
     WHERE pu.email = ${String(email).toLowerCase()} AND m.disabled_at IS NULL
     LIMIT 1
  `.catch(() => []);
  return row && !row.disabled_at ? row.id : null;
}

// A fresh, working way INTO the demo client's portal, minted on demand.
// Invite tokens are stored hashed, so a previously-issued link can never be
// re-read — which is why this is a POST that always mints a new one rather than
// something GET could return. Already got an account? A one-shot magic link
// signs you straight in; otherwise it's the invite (set a password once).
async function portalSignInLink(email, companyId) {
  await ensurePortalTables();
  const puid = await demoPortalAccount(email, companyId);
  if (puid) {
    const raw = createRawToken();
    await sql`
      INSERT INTO portal_login_tokens (id, portal_user_id, token_hash, purpose, expires_at)
      VALUES (${makeId('plt')}, ${puid}, ${hashToken(raw)}, ${'magic_link'},
              ${new Date(Date.now() + 30 * 60 * 1000).toISOString()})
    `;
    return { url: `${PORTAL_BASE}?login=${encodeURIComponent(raw)}`, kind: 'signin' };
  }
  const { rawToken } = await createPortalInvite({
    email, companyId, prefill: { name: 'Demo Client' }, invitedBy: email,
  });
  return { url: inviteUrlFor(rawToken), kind: 'invite' };
}

// The share token + review link for the demo deal's revision, if any.
async function demoLinks(companyId, email) {
  const [deal] = await sql`SELECT id, revision_project_id FROM deals WHERE company_id = ${companyId} ORDER BY created_at ASC LIMIT 1`;
  if (!deal) return { dealId: null };
  const [rp] = deal.revision_project_id
    ? await sql`SELECT share_token FROM revision_projects WHERE id = ${deal.revision_project_id}`
    : [];
  const [sp] = await sql`SELECT share_token FROM storyboard_projects WHERE deal_id = ${deal.id} ORDER BY created_at ASC LIMIT 1`.catch(() => []);
  return {
    dealId: deal.id,
    companyId,
    shareToken: rp?.share_token || null,
    reviewUrl: rp?.share_token ? `${REVISION_PUBLIC_BASE}/?revision=${rp.share_token}` : null,
    portalUrl: PORTAL_BASE,
    // Whether "open the portal" will sign you straight in or ask you to accept
    // the invite first — only affects the hint we show.
    hasPortalAccount: !!(await demoPortalAccount(email, companyId)),
    portalProjectUrl: `${PORTAL_BASE}#/project/${deal.id}`,
    portalReviewUrl: rp?.share_token ? `${PORTAL_BASE}#/review/${rp.share_token}` : null,
    portalStoryboardUrl: sp?.share_token ? `${PORTAL_BASE}#/storyboard/${sp.share_token}` : null,
  };
}

async function seed(email) {
  await ensurePortalTables();
  let companyId = await findDemoCompany();

  // Create the marked demo company + a signed 50/50 deal the first time.
  if (!companyId) {
    companyId = makeId('co');
    await sql`INSERT INTO companies (id, name) VALUES (${companyId}, ${DEMO_COMPANY_NAME})`;

    const dealId = makeId('deal');
    await sql`INSERT INTO deals (id, title, company_id, owner_email, stage, value, last_activity_at)
              VALUES (${dealId}, ${'Demo Explainer Video'}, ${companyId}, ${email || null}, ${'signed'}, ${2400}, NOW())`;

    // A minimal signed 50/50 proposal so the phase bar, steps and final-invoice
    // path all have something to read. total is inc-VAT.
    const proposalId = makeId('prop');
    await sql`INSERT INTO proposals (id, deal_id, data, created_at, updated_at)
              VALUES (${proposalId}, ${dealId}, ${JSON.stringify({ total: '2400', vatRate: 0.2, projectTitle: 'Demo Explainer Video' })}, NOW(), NOW())`;
    await sql`INSERT INTO signatures (proposal_id, name, email, signed_at, data)
              VALUES (${proposalId}, ${'Demo Client'}, ${email || 'demo@example.com'}, NOW(), ${JSON.stringify({ paymentOption: '5050', total: '2400' })})`;

    // Move it into production (creates the first project video, board rows, etc).
    await enterProduction(dealId, { source: 'demo', actorEmail: email });
  }

  // Intentionally NO storyboard/video drafts are seeded. The demo starts clean so
  // you walk the real flow: open the demo video → "Open in Revisions" → upload a
  // draft → "Submit to client for review". The client only sees a review once
  // it's submitted (that's the whole point of the gate we're testing).

  // A live portal invite to the requesting admin's own email — click it to
  // become the "client" and walk the journey. Idempotent per (email, company).
  let inviteUrl = null;
  if (email) {
    try {
      const { rawToken } = await createPortalInvite({ email, companyId, prefill: { name: 'Demo Client' }, invitedBy: email });
      inviteUrl = inviteUrlFor(rawToken);
    } catch (err) {
      console.warn('[demo] portal invite failed', err.message);
    }
  }

  return {
    ...(await demoLinks(companyId, email)),
    inviteUrl,
    blobConfigured: !!REVISION_BLOB_TOKEN,
  };
}

async function teardown() {
  const companyId = await findDemoCompany();
  if (!companyId) return { deleted: false };
  const deals = await sql`SELECT id FROM deals WHERE company_id = ${companyId}`;
  for (const d of deals) {
    // Delete revision blobs first (best-effort), then the revision rows.
    try {
      const versions = await sql`
        SELECT rv.blob_url FROM revision_versions rv
          JOIN revision_projects rp ON rp.id = rv.project_id
         WHERE rp.deal_id = ${d.id} AND rv.blob_url IS NOT NULL`;
      for (const v of versions) { try { await del(v.blob_url, { token: REVISION_BLOB_TOKEN }); } catch { /* best-effort */ } }
      const sbVersions = await sql`
        SELECT sv.blob_url FROM storyboard_versions sv
          JOIN storyboard_projects sp ON sp.id = sv.project_id
         WHERE sp.deal_id = ${d.id} AND sv.blob_url IS NOT NULL`.catch(() => []);
      for (const v of sbVersions) { try { await del(v.blob_url, { token: REVISION_BLOB_TOKEN }); } catch { /* best-effort */ } }
    } catch { /* ignore */ }
    const q = [
      sql`DELETE FROM revision_versions WHERE project_id IN (SELECT id FROM revision_projects WHERE deal_id = ${d.id})`,
      sql`DELETE FROM revision_comments WHERE version_id IN (SELECT vv.id FROM revision_versions vv JOIN revision_projects rp ON rp.id = vv.project_id WHERE rp.deal_id = ${d.id})`.catch(() => {}),
      sql`DELETE FROM revision_videos WHERE project_id IN (SELECT id FROM revision_projects WHERE deal_id = ${d.id})`,
      sql`DELETE FROM revision_projects WHERE deal_id = ${d.id}`,
      sql`DELETE FROM storyboard_versions WHERE project_id IN (SELECT id FROM storyboard_projects WHERE deal_id = ${d.id})`.catch(() => {}),
      sql`DELETE FROM storyboard_comments WHERE version_id IN (SELECT sv.id FROM storyboard_versions sv JOIN storyboard_projects sp ON sp.id = sv.project_id WHERE sp.deal_id = ${d.id})`.catch(() => {}),
      sql`DELETE FROM storyboards WHERE project_id IN (SELECT id FROM storyboard_projects WHERE deal_id = ${d.id})`.catch(() => {}),
      sql`DELETE FROM storyboard_projects WHERE deal_id = ${d.id}`.catch(() => {}),
      sql`DELETE FROM signatures WHERE proposal_id IN (SELECT id FROM proposals WHERE deal_id = ${d.id})`,
      sql`DELETE FROM proposals WHERE deal_id = ${d.id}`,
    ];
    for (const p of q) { try { await p; } catch { /* best-effort */ } }
    try { await sql`DELETE FROM deals WHERE id = ${d.id}`; } catch { /* cascades project_videos/events */ }
  }
  // Company delete cascades portal_memberships + portal_invites (company_id FK).
  try { await sql`DELETE FROM companies WHERE id = ${companyId}`; } catch { /* ignore */ }
  return { deleted: true };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await requirePermission(req, res, ['settings.manage']);
  if (!user) return;

  try {
    if (req.method === 'GET') {
      const companyId = await findDemoCompany();
      if (!companyId) return res.status(200).json({ exists: false });
      return res.status(200).json({ exists: true, ...(await demoLinks(companyId, user.email)) });
    }
    if (req.method === 'POST') {
      const op = (req.query.op || '').toString();
      // Seeding/tearing down changes which deals Finance ignores — drop the
      // cached set so the next report doesn't read a stale one.
      if (op === 'seed') {
        const out = await seed(user.email);
        invalidateDemoScope();
        return res.status(200).json({ ok: true, ...out });
      }
      if (op === 'delete') {
        const out = await teardown();
        invalidateDemoScope();
        return res.status(200).json({ ok: true, ...out });
      }
      if (op === 'portal-link') {
        const companyId = await findDemoCompany();
        if (!companyId) return res.status(404).json({ error: 'No demo project — seed one first.' });
        return res.status(200).json({ ok: true, ...(await portalSignInLink(user.email, companyId)) });
      }
      return res.status(400).json({ error: 'Unknown op' });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[demo] error', err);
    return res.status(500).json({ error: err.message || 'Demo operation failed' });
  }
}
