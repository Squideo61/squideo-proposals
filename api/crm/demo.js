// Admin "demo project" seeder — spins up a self-contained test project so staff
// can walk the whole client journey (portal, in-portal revision review,
// comment/approve, gated download) without a real client or the full sign→pay
// process. Everything hangs off a single marked demo company, so teardown is a
// clean cascade. Admin-only.
//
//   GET  /api/crm/demo                 → { exists, links }
//   POST /api/crm/demo?op=seed         → create (or refresh) the demo, return links
//   POST /api/crm/demo?op=delete       → tear it all down

import { put, del } from '@vercel/blob';
import { cors, requirePermission } from '../_lib/middleware.js';
import sql from '../_lib/db.js';
import { makeId } from '../_lib/crm/shared.js';
import { enterProduction } from '../_lib/production.js';
import { ensurePortalTables } from '../_lib/portal/db.js';
import { createPortalInvite, inviteUrlFor } from '../_lib/portal/onboarding.js';

const DEMO_COMPANY_NAME = '[DEMO] Test Client';
const PORTAL_BASE = process.env.PORTAL_URL || process.env.APP_URL || '';
const REVISION_PUBLIC_BASE = process.env.APP_URL || '';
const REVISION_BLOB_TOKEN = process.env.REVISION_BLOB_READ_WRITE_TOKEN || process.env.REVIEW_BLOB_READ_WRITE_TOKEN;
// A small, stable CC-hosted sample so the review actually plays. Best-effort —
// if the fetch/upload fails, the revision is still created and staff can upload
// their own draft from the Revisions board.
const SAMPLE_VIDEO_URL = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4';

async function findDemoCompany() {
  const [co] = await sql`SELECT id FROM companies WHERE name = ${DEMO_COMPANY_NAME} ORDER BY created_at ASC LIMIT 1`;
  return co?.id || null;
}

// The share token + review link for the demo deal's revision, if any.
async function demoLinks(companyId, email) {
  const [deal] = await sql`SELECT id, revision_project_id FROM deals WHERE company_id = ${companyId} ORDER BY created_at ASC LIMIT 1`;
  if (!deal) return { dealId: null };
  const [rp] = deal.revision_project_id
    ? await sql`SELECT share_token FROM revision_projects WHERE id = ${deal.revision_project_id}`
    : [];
  return {
    dealId: deal.id,
    companyId,
    shareToken: rp?.share_token || null,
    reviewUrl: rp?.share_token ? `${REVISION_PUBLIC_BASE}/?revision=${rp.share_token}` : null,
    portalProjectUrl: `${PORTAL_BASE}#/project/${deal.id}`,
    portalReviewUrl: rp?.share_token ? `${PORTAL_BASE}#/review/${rp.share_token}` : null,
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

  // Ensure a revision project + video + a playable draft on the deal's first video.
  const [deal] = await sql`SELECT id, title, revision_project_id FROM deals WHERE company_id = ${companyId} ORDER BY created_at ASC LIMIT 1`;
  const [video] = await sql`SELECT id, title, revision_video_id FROM project_videos WHERE deal_id = ${deal.id} ORDER BY sort_order ASC, created_at ASC LIMIT 1`;

  let revProjectId = deal.revision_project_id;
  let shareToken = revProjectId ? (await sql`SELECT share_token FROM revision_projects WHERE id = ${revProjectId}`)[0]?.share_token : null;
  if (!revProjectId || !shareToken) {
    revProjectId = makeId('rp');
    shareToken = makeId('tok').replace(/[^a-z0-9]/gi, '') + makeId('tok').replace(/[^a-z0-9]/gi, '');
    await sql`INSERT INTO revision_projects (id, title, client_name, share_token, created_by, deal_id)
              VALUES (${revProjectId}, ${deal.title}, ${DEMO_COMPANY_NAME}, ${shareToken}, ${email || null}, ${deal.id})`;
    await sql`UPDATE deals SET revision_project_id = ${revProjectId} WHERE id = ${deal.id}`;
  }
  let revVideoId = video?.revision_video_id || null;
  if (video && !revVideoId) {
    revVideoId = makeId('rv');
    await sql`INSERT INTO revision_videos (id, project_id, title, sort_order) VALUES (${revVideoId}, ${revProjectId}, ${video.title}, 0)`;
    await sql`UPDATE project_videos SET revision_video_id = ${revVideoId} WHERE id = ${video.id}`;
  }

  // Best-effort: attach a playable sample draft if there isn't one yet.
  let draftAttached = false;
  if (revVideoId) {
    const [existing] = await sql`SELECT id FROM revision_versions WHERE video_id = ${revVideoId} LIMIT 1`;
    if (existing) {
      draftAttached = true;
    } else if (REVISION_BLOB_TOKEN) {
      try {
        const resp = await fetch(SAMPLE_VIDEO_URL);
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          const blob = await put(`revision-videos/demo/${makeId('v')}.mp4`, buf, { access: 'public', token: REVISION_BLOB_TOKEN, contentType: 'video/mp4' });
          await sql`INSERT INTO revision_versions (id, project_id, video_id, version_number, label, filename, mime_type, size_bytes, blob_url, blob_pathname, uploaded_by)
                    VALUES (${makeId('rver')}, ${revProjectId}, ${revVideoId}, 1, ${'Draft 1'}, ${'demo-draft.mp4'}, ${'video/mp4'}, ${buf.length}, ${blob.url}, ${blob.pathname}, ${email || null})`;
          draftAttached = true;
        }
      } catch (err) {
        console.warn('[demo] sample draft upload failed', err.message);
      }
    }
  }

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

  return { ...(await demoLinks(companyId, email)), inviteUrl, draftAttached };
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
    } catch { /* ignore */ }
    const q = [
      sql`DELETE FROM revision_versions WHERE project_id IN (SELECT id FROM revision_projects WHERE deal_id = ${d.id})`,
      sql`DELETE FROM revision_comments WHERE version_id IN (SELECT vv.id FROM revision_versions vv JOIN revision_projects rp ON rp.id = vv.project_id WHERE rp.deal_id = ${d.id})`.catch(() => {}),
      sql`DELETE FROM revision_videos WHERE project_id IN (SELECT id FROM revision_projects WHERE deal_id = ${d.id})`,
      sql`DELETE FROM revision_projects WHERE deal_id = ${d.id}`,
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
      if (op === 'seed') return res.status(200).json({ ok: true, ...(await seed(user.email)) });
      if (op === 'delete') return res.status(200).json({ ok: true, ...(await teardown()) });
      return res.status(400).json({ error: 'Unknown op' });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[demo] error', err);
    return res.status(500).json({ error: err.message || 'Demo operation failed' });
  }
}
