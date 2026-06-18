import crypto from 'node:crypto';
import { put, del, getDownloadUrl } from '@vercel/blob';
import sql from '../db.js';
import { isValidStage } from '../dealStage.js';
import { makeId, trimOrNull, lowerOrNull, numberOrNull, ensureMessageDealsTable, ensureDealContactsTable, driveFilesEnabled } from './shared.js';
import { serialiseTask } from './tasks.js';
import { serialiseComment, notifyCommentMentions } from './comments.js';
import { serialiseContact } from './contacts.js';
import { getFreshAccessToken } from './gmail.js';
import { trackingForDealThreads, trackingForMessages, backfillDealTrackingIds } from './tracking.js';
import { ensureDealFolder, uploadToFolder, getDriveFileLink, deleteDriveFile, folderUsable, listFolderFiles, createResumableUploadSession, applyFolderTemplate, listSubfolderTree, isFolderWithin, listFolderContents, getDriveFile } from '../googleDrive.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { enterProduction } from '../production.js';
import { sendNotification } from '../notifications.js';
import { APP_URL } from '../email.js';

// Self-heal for db/migrations/20260604_deal_files_drive.sql — Drive-backed
// deal files. Idempotent and cached; also relaxes blob_url's NOT NULL so
// Drive rows (no blob) can be stored.
let dealFileDriveEnsured = null;
export function ensureDealFileDriveColumns() {
  if (dealFileDriveEnsured) return dealFileDriveEnsured;
  dealFileDriveEnsured = (async () => {
    await sql`ALTER TABLE deal_files ADD COLUMN IF NOT EXISTS drive_file_id TEXT`;
    await sql`ALTER TABLE deal_files ADD COLUMN IF NOT EXISTS web_view_link TEXT`;
    await sql`ALTER TABLE deal_files ALTER COLUMN blob_url DROP NOT NULL`;
    await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS drive_folder_id TEXT`;
    await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS overview_video_url TEXT`;
  })().catch((err) => { dealFileDriveEnsured = null; throw err; });
  return dealFileDriveEnsured;
}

// Self-heal for db/migrations/20260610_deal_purchase_orders.sql — Purchase-Order
// tracking on PO-route deals: a received PO number/date on the deal, plus a
// dedicated Blob-backed file table for uploaded PO documents. Kept separate from
// deal_files because the Drive mirror (reconcileDealDriveFiles) deletes
// deal_files rows not present in Drive, which would wipe Blob-only PO docs.
let dealPoEnsured = null;
export function ensureDealPo() {
  if (dealPoEnsured) return dealPoEnsured;
  dealPoEnsured = (async () => {
    await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS po_number TEXT`;
    await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS po_received_at TIMESTAMPTZ`;
    await sql`
      CREATE TABLE IF NOT EXISTS deal_po_files (
        id            TEXT        PRIMARY KEY,
        deal_id       TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        filename      TEXT        NOT NULL,
        mime_type     TEXT,
        size_bytes    BIGINT,
        blob_url      TEXT,
        blob_pathname TEXT,
        uploaded_by   TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS deal_po_files_deal_idx ON deal_po_files (deal_id)`;
  })().catch((err) => { dealPoEnsured = null; throw err; });
  return dealPoEnsured;
}

// Self-heal for db/migrations/20260616_deal_hot_flag.sql — the orthogonal "hot"
// warm-lead marker (settable at any stage). Cached so it runs at most once per
// warm instance.
let dealHotEnsured = null;
export function ensureDealHot() {
  if (dealHotEnsured) return dealHotEnsured;
  dealHotEnsured = sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS hot BOOLEAN NOT NULL DEFAULT FALSE`
    .then(() => {}).catch((err) => { dealHotEnsured = null; throw err; });
  return dealHotEnsured;
}

// Self-heal for db/migrations/20260617_deal_vat_rate.sql — a per-deal VAT rate
// stored as a fraction (0.2 = 20%). Nullable; null is treated as the standard
// 20% at display time. Cached so it runs at most once per warm instance.
let dealVatEnsured = null;
export function ensureDealVat() {
  if (dealVatEnsured) return dealVatEnsured;
  dealVatEnsured = sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS vat_rate NUMERIC`
    .then(() => {}).catch((err) => { dealVatEnsured = null; throw err; });
  return dealVatEnsured;
}

// Turn a Drive API error into an actionable message for the user.
export function driveErrorHint(err) {
  const msg = err?.message || '';
  const status = err?.status;
  if (status === 401 || /scope|unauthorized|invalid credentials/i.test(msg)) {
    return 'Google Drive access not granted — reconnect your Google account (Account → Settings → reconnect) and allow Drive.';
  }
  if (status === 404) {
    return "Drive folder not found — check DEAL_DRIVE_ROOT_ID is the correct Shared Drive id and that your Google account is a member of it.";
  }
  if (status === 403) {
    if (/has not been used|is disabled|accessNotConfigured|SERVICE_DISABLED/i.test(msg)) {
      return 'The Google Drive API is disabled for this Google Cloud project — enable it, then try again.';
    }
    return "Google Drive permission denied — reconnect Google (granting Drive) and make sure you're a member of the Shared Drive.";
  }
  return 'Could not start Google Drive upload: ' + (msg || 'unknown error');
}

// Find-or-create a deal's Shared Drive folder, caching its id on the deal so we
// only hit Drive once per deal.
export async function dealDriveFolder(accessToken, dealId) {
  const [d] = await sql`SELECT drive_folder_id, title FROM deals WHERE id = ${dealId}`;
  if (d?.drive_folder_id) {
    // Self-heal: if the cached folder was deleted/trashed in Drive, clear it and
    // re-find (by the deal tag) or recreate below. Auth/transient errors bubble
    // up rather than wrongly recreating.
    let usable = true;
    try { usable = await folderUsable(accessToken, d.drive_folder_id); }
    catch { return d.drive_folder_id; }
    if (usable) return d.drive_folder_id;
    await sql`UPDATE deals SET drive_folder_id = NULL WHERE id = ${dealId}`;
  }
  // Name the folder "<project number> — <title>" — the proposal number doubles
  // as the project number, so folders read and sort sensibly in Drive.
  const [p] = await sql`
    SELECT number_year AS ny, number_seq AS ns
      FROM proposals
     WHERE deal_id = ${dealId} AND number_year IS NOT NULL AND number_seq IS NOT NULL
     ORDER BY number_seq ASC LIMIT 1`;
  const num = p?.ny && p?.ns ? `${p.ny}-${String(p.ns).padStart(3, '0')}` : null;
  const title = d?.title || dealId;
  const name = num ? `${num} — ${title}` : title;
  const folderId = await ensureDealFolder(accessToken, { dealId, name });
  await sql`UPDATE deals SET drive_folder_id = ${folderId} WHERE id = ${dealId}`;
  return folderId;
}

// Make the deal's stored file list mirror its Drive folder: drop rows for files
// deleted in Drive, and add rows for files dropped straight into the folder.
// Best-effort — callers wrap in try/catch so a Drive blip never breaks loading.
async function reconcileDealDriveFiles(dealId, folderId, accessToken) {
  const driveFiles = (await listFolderFiles(accessToken, folderId))
    .filter((f) => f.mimeType !== 'application/vnd.google-apps.folder');
  const driveIds = new Set(driveFiles.map((f) => f.id));

  const rows = await sql`SELECT id, drive_file_id FROM deal_files WHERE deal_id = ${dealId} AND drive_file_id IS NOT NULL`;
  const known = new Set(rows.map((r) => r.drive_file_id));

  const stale = rows.filter((r) => !driveIds.has(r.drive_file_id)).map((r) => r.id);
  if (stale.length) await sql`DELETE FROM deal_files WHERE id = ANY(${stale})`;

  for (const f of driveFiles) {
    if (known.has(f.id)) continue;
    await sql`
      INSERT INTO deal_files (id, deal_id, filename, mime_type, size_bytes, blob_url, drive_file_id, web_view_link, uploaded_by, source, created_at)
      VALUES (${crypto.randomUUID()}, ${dealId}, ${f.name}, ${f.mimeType || null},
              ${f.size != null ? Number(f.size) : null}, NULL, ${f.id}, ${f.webViewLink || null},
              NULL, 'upload', ${f.createdTime || new Date().toISOString()})
    `;
  }
}

// Normalise a producers payload to a deduped email array. Accepts the new
// `producerEmails` array or the legacy single `producerEmail`.
function readDealProducerEmails(body) {
  if (Array.isArray(body.producerEmails)) {
    return Array.from(new Set(body.producerEmails.map(trimOrNull).filter(Boolean)));
  }
  if ('producerEmail' in body) {
    const v = trimOrNull(body.producerEmail);
    return v ? [v] : [];
  }
  return [];
}

async function setDealAssignees(dealId, emails) {
  await sql`DELETE FROM deal_assignees WHERE deal_id = ${dealId}`;
  if (emails.length) {
    await sql`INSERT INTO deal_assignees (deal_id, user_email) SELECT ${dealId}, unnest(${emails}::text[]) ON CONFLICT DO NOTHING`;
  }
}

// Annotate a set of deal rows (must be SELECT * so po fields are present) with
// the per-deal extras the Kanban / pipeline render from: proposal + video counts,
// sale status (PO route + invoiced) and engagement tracking (proposal + email
// opens). Shared by the deals list and the stage-move response so a drag-drop
// reflects fresh pills/tracking immediately. Each lookup is guarded so a missing
// table degrades quietly; all batched/keyed by deal id.
export async function annotateDeals(rows) {
  await ensureDealPo();
  const ids = rows.map(r => r.id);
  if (!ids.length) return [];

  const proposalCounts = await sql`SELECT deal_id, COUNT(*)::int AS n FROM proposals WHERE deal_id = ANY(${ids}) GROUP BY deal_id`;
  const propMap = new Map(proposalCounts.map(r => [r.deal_id, r.n]));

  let vidMap = new Map();
  try {
    const videoCounts = await sql`SELECT deal_id, COUNT(*)::int AS n FROM project_videos WHERE deal_id = ANY(${ids}) GROUP BY deal_id`;
    vidMap = new Map(videoCounts.map(r => [r.deal_id, r.n]));
  } catch (_) { /* project_videos not yet migrated */ }

  // PO route: any signed proposal on the deal chose the PO payment option.
  let poRouteSet = new Set();
  try {
    const poRows = await sql`
      SELECT p.deal_id AS did, bool_or(s.data->>'paymentOption' = 'po') AS is_po
        FROM signatures s JOIN proposals p ON p.id = s.proposal_id
       WHERE p.deal_id = ANY(${ids}) GROUP BY p.deal_id`;
    poRouteSet = new Set(poRows.filter(r => r.is_po).map(r => r.did));
  } catch (_) { /* no signatures table */ }

  // Invoiced: a manual invoice (issued/paid) or a raised proposal-billing invoice.
  let invoicedSet = new Set();
  try {
    const invRows = await sql`
      SELECT DISTINCT did FROM (
        SELECT COALESCE(mi.deal_id, pr.deal_id) AS did
          FROM manual_invoices mi
          LEFT JOIN proposals pr ON pr.id = mi.proposal_id
         WHERE mi.status IN ('issued','paid')
           AND COALESCE(mi.deal_id, pr.deal_id) = ANY(${ids})
        UNION
        SELECT p.deal_id AS did
          FROM proposal_billing pb JOIN proposals p ON p.id = pb.proposal_id
         WHERE pb.xero_invoice_id IS NOT NULL AND p.deal_id = ANY(${ids})
      ) q WHERE did IS NOT NULL`;
    invoicedSet = new Set(invRows.map(r => r.did));
  } catch (_) { /* invoices tables not present */ }

  // Proposal opens (the client opening the proposal).
  let propViewMap = new Map();
  try {
    const pvRows = await sql`
      SELECT p.deal_id AS did, COUNT(*)::int AS opens, MAX(pv.last_active_at) AS last_at,
             COALESCE(SUM(pv.duration_seconds),0)::int AS secs,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT pv.city), NULL) AS cities,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT pv.country), NULL) AS countries
        FROM proposal_views pv JOIN proposals p ON p.id = pv.proposal_id
       WHERE p.deal_id = ANY(${ids}) GROUP BY p.deal_id`;
    propViewMap = new Map(pvRows.map(r => [r.did, r]));
  } catch (_) { /* proposal_views not present */ }

  // Email opens (real opens > 5s after send, on the deal's tracked threads).
  let emailOpenMap = new Map();
  try {
    const eoRows = await sql`
      SELECT etd.deal_id AS did,
             COUNT(*) FILTER (WHERE ev.kind='open' AND ev.occurred_at > t.sent_at + interval '5 seconds')::int AS opens,
             MAX(ev.occurred_at) FILTER (WHERE ev.kind='open' AND ev.occurred_at > t.sent_at + interval '5 seconds') AS last_at
        FROM email_thread_deals etd
        JOIN email_tracking t ON t.gmail_thread_id = etd.gmail_thread_id
        LEFT JOIN email_tracking_events ev ON ev.tracking_id = t.id
       WHERE etd.deal_id = ANY(${ids}) GROUP BY etd.deal_id`;
    emailOpenMap = new Map(eoRows.map(r => [r.did, r]));
  } catch (_) { /* email_tracking not present */ }

  // Next incomplete task per deal (earliest due first, undated last).
  let nextTaskMap = new Map();
  try {
    const taskRows = await sql`
      SELECT DISTINCT ON (deal_id) deal_id, title, due_at
        FROM tasks
       WHERE deal_id = ANY(${ids}) AND done_at IS NULL
       ORDER BY deal_id, due_at ASC NULLS LAST`;
    nextTaskMap = new Map(taskRows.map(r => [r.deal_id, { title: r.title, dueAt: r.due_at || null }]));
  } catch (_) { /* tasks not present */ }

  // Most recent email (sent or received) linked to each deal — thread- or
  // message-scoped, mirroring the deal-detail email union.
  let lastEmailMap = new Map();
  try {
    const emRows = await sql`
      SELECT deal_id, MAX(sent_at) AS last_at FROM (
        SELECT etd.deal_id, em.sent_at
          FROM email_thread_deals etd JOIN email_messages em ON em.gmail_thread_id = etd.gmail_thread_id
         WHERE etd.deal_id = ANY(${ids})
        UNION ALL
        SELECT emd.deal_id, em.sent_at
          FROM email_message_deals emd JOIN email_messages em ON em.gmail_message_id = emd.gmail_message_id
         WHERE emd.deal_id = ANY(${ids})
      ) q GROUP BY deal_id`;
    lastEmailMap = new Map(emRows.map(r => [r.deal_id, r.last_at]));
  } catch (_) { /* email tables not present */ }

  // Proposal-derived value per deal. The signed proposal's total is the actual
  // sale value (incl. selected extras), otherwise the latest proposal's total.
  // Lets the pipeline show a figure for a deal that has a proposal but no manual
  // value, and reflect the real signed amount once signed.
  let valueByDeal = new Map();
  try {
    const propRows = await sql`
      SELECT p.deal_id AS did, p.data, p.created_at, s.data AS signature_data
        FROM proposals p
        LEFT JOIN signatures s ON s.proposal_id = p.id
       WHERE p.deal_id = ANY(${ids})`;
    const byDeal = new Map();
    for (const pr of propRows) {
      if (!byDeal.has(pr.did)) byDeal.set(pr.did, []);
      byDeal.get(pr.did).push(pr);
    }
    const newest = (list) => list.reduce((b, p) => (b && new Date(b.created_at) >= new Date(p.created_at) ? b : p), null);
    for (const [did, props] of byDeal) {
      const signed = newest(props.filter(p => p.signature_data));
      const latest = newest(props);
      valueByDeal.set(did, {
        signedValue: signed ? computeProposalTotalExVat(signed.data, signed.signature_data) : null,
        latestValue: latest ? computeProposalTotalExVat(latest.data, latest.signature_data) : null,
      });
    }
  } catch (_) { /* proposals/signatures not present */ }

  return rows.map(r => {
    const pv = propViewMap.get(r.id);
    const eo = emailOpenMap.get(r.id);
    // Effective value: signed sale value wins, then a manual deal value, then
    // the latest proposed value.
    const vinfo = valueByDeal.get(r.id) || {};
    const manualVal = r.value != null ? Number(r.value) : null;
    let effectiveValue = null;
    let valueSource = null;
    if (vinfo.signedValue != null) { effectiveValue = vinfo.signedValue; valueSource = 'signed'; }
    else if (manualVal != null) { effectiveValue = manualVal; valueSource = 'manual'; }
    else if (vinfo.latestValue != null) { effectiveValue = vinfo.latestValue; valueSource = 'proposal'; }
    const proposalOpens = pv ? Number(pv.opens) || 0 : 0;
    const emailOpens = eo ? Number(eo.opens) || 0 : 0;
    const lastProposalOpenAt = pv?.last_at || null;
    const lastEmailOpenAt = eo?.last_at || null;
    const locations = [];
    for (const c of (pv?.cities || [])) if (c) locations.push(c);
    if (!locations.length) for (const c of (pv?.countries || [])) if (c) locations.push(c);
    const ts = [lastProposalOpenAt, lastEmailOpenAt].filter(Boolean).map(t => new Date(t).getTime());
    const lastOpenedAt = ts.length ? new Date(Math.max(...ts)).toISOString() : null;
    return {
      ...serialiseDeal(r),
      effectiveValue,
      valueSource,
      proposalCount: propMap.get(r.id) || 0,
      videoCount: vidMap.get(r.id) || 0,
      nextTask: nextTaskMap.get(r.id) || null,
      lastEmailAt: lastEmailMap.get(r.id) || null,
      saleStatus: {
        isPo: poRouteSet.has(r.id),
        poNumber: r.po_number || null,
        poReceivedAt: r.po_received_at || null,
        invoiced: invoicedSet.has(r.id),
      },
      tracking: {
        tracked: proposalOpens + emailOpens > 0,
        proposalOpens, lastProposalOpenAt,
        emailOpens, lastEmailOpenAt,
        locations, totalSeconds: pv ? Number(pv.secs) || 0 : 0,
        lastOpenedAt,
      },
    };
  });
}

// Lead-source summary for a deal: the first-touch marketing attribution from the
// quote request that became this deal (channel / campaign / keyword / landing
// page), plus a `returningClient` flag — true when the deal's company already
// has another signed/paid deal (an existing client re-enquiring via the form).
// Returns null for deals that didn't come from a quote request.
export async function dealLeadSource(deal) {
  if (!deal?.id) return null;
  let qr;
  try {
    const rows = await sql`
      SELECT attr_channel, attr_source, attr_medium, attr_campaign, attr_campaign_id,
             attr_keyword, attr_term, attr_landing_url, attr_referrer, attr_gclid,
             attr_first_seen_at, created_at
        FROM quote_requests
       WHERE deal_id = ${deal.id}
       ORDER BY created_at ASC LIMIT 1`;
    qr = rows[0];
  } catch (_) { return null; /* attribution columns not present */ }
  if (!qr) return null;

  let campaignName = null;
  if (qr.attr_campaign_id) {
    try {
      const n = await sql`SELECT name FROM ad_campaigns WHERE campaign_id = ${qr.attr_campaign_id} LIMIT 1`;
      campaignName = n[0]?.name || null;
    } catch (_) { /* ad_campaigns not present */ }
  }

  let returningClient = false;
  if (deal.companyId) {
    try {
      const w = await sql`
        SELECT 1 FROM deals
         WHERE company_id = ${deal.companyId} AND stage IN ('signed','paid') AND id <> ${deal.id}
         LIMIT 1`;
      returningClient = w.length > 0;
    } catch (_) { /* ignore */ }
  }

  const nonNumeric = (v) => (v && !/^\d+$/.test(v) ? v : null);
  return {
    channel: qr.attr_channel || null,
    source: qr.attr_source || null,
    medium: qr.attr_medium || null,
    campaign: campaignName || nonNumeric(qr.attr_campaign) || qr.attr_campaign || null,
    campaignId: qr.attr_campaign_id || null,
    keyword: qr.attr_keyword || qr.attr_term || null,
    landingUrl: qr.attr_landing_url || null,
    referrer: qr.attr_referrer || null,
    gclid: qr.attr_gclid || null,
    firstSeenAt: qr.attr_first_seen_at || null,
    submittedAt: qr.created_at || null,
    returningClient,
  };
}

export async function dealsRoute(req, res, id, action, user, subaction = null) {
  // Cheap (cached) self-heal so the `hot` and `vat_rate` columns are present for
  // every list / detail SELECT * and the writes below, even before the
  // migrations are applied.
  await ensureDealHot();
  await ensureDealVat();
  if (!id) {
    if (req.method === 'GET') {
      // Optional filter by stage, owner. Default: everything (Kanban renders
      // stages as columns and groups client-side).
      const stage = req.query.stage ? String(req.query.stage) : null;
      const owner = req.query.owner ? String(req.query.owner) : null;
      let rows;
      if (stage && owner) {
        rows = await sql`SELECT * FROM deals WHERE stage = ${stage} AND owner_email = ${owner} ORDER BY stage_changed_at DESC`;
      } else if (stage) {
        rows = await sql`SELECT * FROM deals WHERE stage = ${stage} ORDER BY stage_changed_at DESC`;
      } else if (owner) {
        rows = await sql`SELECT * FROM deals WHERE owner_email = ${owner} ORDER BY stage_changed_at DESC`;
      } else {
        rows = await sql`SELECT * FROM deals ORDER BY stage_changed_at DESC`;
      }

      return res.status(200).json(await annotateDeals(rows));
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const title = trimOrNull(body.title);
      if (!title) return res.status(400).json({ error: 'title is required' });
      const newId = body.id || makeId('deal');
      const stage = isValidStage(body.stage) ? body.stage : 'lead';
      await sql`
        INSERT INTO deals (id, title, company_id, primary_contact_id, owner_email, stage, value, vat_rate, expected_close_at, notes)
        VALUES (
          ${newId},
          ${title},
          ${trimOrNull(body.companyId) || null},
          ${trimOrNull(body.primaryContactId) || null},
          ${trimOrNull(body.ownerEmail) || user.email},
          ${stage},
          ${numberOrNull(body.value)},
          ${numberOrNull(body.vatRate)},
          ${trimOrNull(body.expectedCloseAt)},
          ${trimOrNull(body.notes)}
        )
      `;
      await sql`
        INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
        VALUES (${newId}, 'deal_created', ${JSON.stringify({ title, stage, source: 'manual' })}, ${user.email || null})
      `;
      const rows = await sql`
        SELECT id, title, company_id, primary_contact_id, owner_email, stage, stage_changed_at,
               value, vat_rate, expected_close_at, lost_reason, notes, last_activity_at, created_at, updated_at
        FROM deals WHERE id = ${newId}
      `;
      return res.status(201).json(serialiseDeal(rows[0]));
    }
    return res.status(405).end();
  }

  // Sub-routes: /deals/:id/stage and /deals/:id/events
  if (action === 'stage') {
    if (req.method !== 'POST') return res.status(405).end();
    const { stage, lostReason } = req.body || {};
    if (!isValidStage(stage)) return res.status(400).json({ error: 'Invalid stage' });
    // Manual move: bypass the forward-only ratchet but still record an event.
    const cur = (await sql`SELECT stage FROM deals WHERE id = ${id}`)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    if (cur.stage === stage && stage !== 'lost') {
      return res.status(200).json({ ok: true, changed: false });
    }
    await sql`
      UPDATE deals
         SET stage = ${stage},
             stage_changed_at = NOW(),
             last_activity_at = NOW(),
             lost_reason = ${stage === 'lost' ? trimOrNull(lostReason) : null},
             updated_at = NOW()
       WHERE id = ${id}
    `;
    await sql`
      INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
      VALUES (${id}, 'stage_change', ${JSON.stringify({ from: cur.stage, to: stage, manual: true, lostReason: lostReason || null })}, ${user.email || null})
    `;
    // Return the FULLY annotated deal (saleStatus + tracking) so the pipeline's
    // pills/engagement update immediately on drop, with fresh server state.
    const rows = await sql`SELECT * FROM deals WHERE id = ${id}`;
    const [deal] = await annotateDeals(rows);
    return res.status(200).json({ ok: true, changed: true, deal });
  }

  // Orthogonal "hot" flag — a warm-lead marker independent of the stage, so a
  // deal can be flagged keen at any point in the funnel. POST { hot: bool }.
  if (action === 'hot') {
    if (req.method !== 'POST') return res.status(405).end();
    const hot = !!(req.body && req.body.hot);
    // "Hot" is a sales/lead warmth marker — a deal that's already a project in
    // production can't be flagged hot. Unflagging (hot=false) stays allowed so a
    // pre-existing flag can still be cleared.
    if (hot) {
      const [cur] = await sql`SELECT production_phase FROM deals WHERE id = ${id}`;
      if (!cur) return res.status(404).json({ error: 'Not found' });
      if (cur.production_phase) return res.status(409).json({ error: 'A project in production can’t be flagged hot.' });
    }
    const updated = await sql`
      UPDATE deals SET hot = ${hot}, updated_at = NOW() WHERE id = ${id}
      RETURNING id
    `;
    if (!updated.length) return res.status(404).json({ error: 'Not found' });
    const rows = await sql`SELECT * FROM deals WHERE id = ${id}`;
    const [deal] = await annotateDeals(rows);
    return res.status(200).json({ ok: true, deal });
  }

  // "Good to go" — the explicit gate that turns a sold deal into a production
  // project. This replaces the old auto-on-payment entry: a person confirms the
  // deal is ready, which moves it onto the board (Pre-Production / New Project,
  // with one video) AND alerts the project managers. Eligibility: the deal must
  // be committed — signed, paid, or on a purchase order. One-way (there's no
  // un-enter), so a 409 protects against an accidental too-early click.
  if (action === 'good-to-go') {
    if (req.method !== 'POST') return res.status(405).end();
    const [d] = await sql`SELECT id, title, stage, po_number, production_phase FROM deals WHERE id = ${id}`;
    if (!d) return res.status(404).json({ error: 'Not found' });
    // Idempotent: already a project → return it unchanged (no second notification).
    if (d.production_phase) {
      const rows = await sql`SELECT * FROM deals WHERE id = ${id}`;
      const [deal] = await annotateDeals(rows);
      return res.status(200).json({ ok: true, alreadyInProduction: true, deal });
    }
    const [{ signed }] = await sql`
      SELECT EXISTS (
        SELECT 1 FROM signatures s JOIN proposals p ON p.id = s.proposal_id WHERE p.deal_id = ${id}
      ) AS signed`;
    const eligible = !!signed || d.po_number != null || ['signed', 'paid', 'long_term'].includes(d.stage);
    if (!eligible) {
      return res.status(409).json({
        error: 'This deal isn’t ready yet — a deal must be signed, paid, or on a purchase order before it can be marked good to go.',
      });
    }
    const result = await enterProduction(id, { source: 'good-to-go', actorEmail: user.email || null });
    // Alert the project managers that there's a new project to pick up. Best-
    // effort — a notification failure must never undo the production entry.
    if (result.entered) {
      try { await notifyGoodToGo(d, user); }
      catch (err) { console.error('[deals] good-to-go notify failed', err); }
    }
    const rows = await sql`SELECT * FROM deals WHERE id = ${id}`;
    const [deal] = await annotateDeals(rows);
    return res.status(200).json({ ok: true, deal });
  }

  if (action === 'comments') {
    if (req.method !== 'POST') return res.status(405).end();
    const body = req.body || {};
    const text = trimOrNull(body.body);
    if (!text) return res.status(400).json({ error: 'body is required' });
    const parentId = trimOrNull(body.parentId) || null;
    const mentions = Array.isArray(body.mentions) ? body.mentions.filter(m => typeof m === 'string') : [];
    const newId = makeId('cmt');
    await sql`
      INSERT INTO deal_comments (id, deal_id, parent_id, body, mentions, created_by)
      VALUES (${newId}, ${id}, ${parentId}, ${text}, ${mentions}, ${user.email})
    `;
    await sql`
      UPDATE deals SET last_activity_at = NOW(), updated_at = NOW() WHERE id = ${id}
    `;
    // Ping any @-mentioned teammates (in-app + email + desktop push). Best-effort
    // so a notification problem never fails the comment itself.
    if (mentions.length) {
      try { await notifyCommentMentions({ dealId: id, body: text, mentions, author: user }); }
      catch (err) { console.error('[deals] comment mention notify failed', err); }
    }
    const rows = await sql`
      SELECT c.id, c.deal_id, c.parent_id, c.body, c.mentions,
             c.created_by, c.created_at, c.updated_at,
             u.name AS author_name, u.avatar AS author_avatar
      FROM deal_comments c
      JOIN users u ON u.email = c.created_by
      WHERE c.id = ${newId}
    `;
    return res.status(201).json(serialiseComment(rows[0]));
  }

  if (action === 'events') {
    if (req.method !== 'GET') return res.status(405).end();
    const rows = await sql`
      SELECT id, deal_id, event_type, payload, actor_email, occurred_at
      FROM deal_events
      WHERE deal_id = ${id}
      ORDER BY occurred_at DESC
      LIMIT 200
    `;
    return res.status(200).json(rows.map(r => ({
      id: Number(r.id),
      dealId: r.deal_id,
      eventType: r.event_type,
      payload: r.payload || {},
      actorEmail: r.actor_email || null,
      occurredAt: r.occurred_at,
    })));
  }

  // /deals/:id/po — record (POST) or clear (DELETE) the received purchase order
  // for a PO-route deal. Marking received requires a non-empty PO number; that
  // number becomes the reference on the deal's Xero invoice.
  if (action === 'po' && !subaction) {
    await ensureDealPo();
    if (req.method === 'POST') {
      const poNumber = trimOrNull((req.body || {}).poNumber);
      if (!poNumber) return res.status(400).json({ error: 'PO number is required' });
      await sql`UPDATE deals SET po_number = ${poNumber}, po_received_at = NOW(), updated_at = NOW() WHERE id = ${id}`;
      await sql`
        INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
        VALUES (${id}, 'po_received', ${JSON.stringify({ poNumber })}, ${user.email || null})`;
      const [d] = await sql`SELECT po_number, po_received_at FROM deals WHERE id = ${id}`;
      return res.status(200).json({ ok: true, poNumber: d?.po_number || null, poReceivedAt: d?.po_received_at || null });
    }
    if (req.method === 'DELETE') {
      await sql`UPDATE deals SET po_number = NULL, po_received_at = NULL, updated_at = NOW() WHERE id = ${id}`;
      await sql`
        INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
        VALUES (${id}, 'po_cleared', ${JSON.stringify({})}, ${user.email || null})`;
      return res.status(200).json({ ok: true, poNumber: null, poReceivedAt: null });
    }
    return res.status(405).end();
  }

  // /deals/:id/po-files — upload a PO document (POST, raw binary like the Blob
  // file upload), or download (GET /:fileId) / delete (DELETE /:fileId) one.
  // Blob-only by design (see ensureDealPo).
  if (action === 'po-files' && !subaction && req.method === 'POST') {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: 'File storage not configured' });
    await ensureDealPo();
    const filename = decodeURIComponent(req.headers['x-filename'] || 'purchase-order');
    const mimeType = req.headers['content-type'] || 'application/octet-stream';
    let fileBuffer = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : null;
    if (!fileBuffer) {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      fileBuffer = Buffer.concat(chunks);
    }
    if (!fileBuffer || fileBuffer.length === 0) return res.status(400).json({ error: 'No file data received' });
    if (fileBuffer.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'File too large (max 20 MB)' });
    const fileId = crypto.randomUUID();
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = await put(`deal-po-files/${id}/${fileId}/${safeName}`, fileBuffer, { access: 'private', contentType: mimeType });
    await sql`
      INSERT INTO deal_po_files (id, deal_id, filename, mime_type, size_bytes, blob_url, blob_pathname, uploaded_by)
      VALUES (${fileId}, ${id}, ${filename}, ${mimeType}, ${fileBuffer.length}, ${blob.url}, ${blob.pathname}, ${user.email})`;
    return res.status(201).json({
      id: fileId, filename, mimeType, sizeBytes: fileBuffer.length,
      uploadedBy: user.email, createdAt: new Date().toISOString(),
    });
  }

  if (action === 'po-files' && subaction && req.method === 'GET') {
    await ensureDealPo();
    const [f] = await sql`SELECT blob_url, filename FROM deal_po_files WHERE id = ${subaction} AND deal_id = ${id}`;
    if (!f) return res.status(404).json({ error: 'File not found' });
    const downloadUrl = await getDownloadUrl(f.blob_url);
    return res.status(200).json({ downloadUrl, filename: f.filename });
  }

  if (action === 'po-files' && subaction && req.method === 'DELETE') {
    await ensureDealPo();
    const [f] = await sql`SELECT blob_url, uploaded_by FROM deal_po_files WHERE id = ${subaction} AND deal_id = ${id}`;
    if (!f) return res.status(404).json({ error: 'File not found' });
    if (f.uploaded_by !== user.email && !hasPermission(await getRole(user.role), 'deals.manage_all')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (f.blob_url) { try { await del(f.blob_url); } catch (err) { console.error('[deal po-files] blob delete failed', err.message); } }
    await sql`DELETE FROM deal_po_files WHERE id = ${subaction} AND deal_id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  // Used by the in-Gmail Boxes RouteView — every thread attached to this deal.
  if (action === 'threads') {
    if (req.method !== 'GET') return res.status(405).end();
    const rows = await sql`
      SELECT et.gmail_thread_id, et.subject, et.last_message_at, et.participant_emails,
             (SELECT COUNT(*) FROM email_messages em WHERE em.gmail_thread_id = et.gmail_thread_id AND em.gmail_message_id NOT LIKE '%-stub')::int AS message_count
      FROM email_threads et
      JOIN email_thread_deals etd ON etd.gmail_thread_id = et.gmail_thread_id
      WHERE etd.deal_id = ${id}
      ORDER BY et.last_message_at DESC NULLS LAST
      LIMIT 200
    `;
    return res.status(200).json(rows.map(r => ({
      gmailThreadId: r.gmail_thread_id,
      subject: r.subject || null,
      lastMessageAt: r.last_message_at,
      participantEmails: r.participant_emails || [],
      messageCount: r.message_count || 0,
    })));
  }

  // A deal with exactly one contact and no primary set promotes that lone
  // contact to primary automatically (it moves out of the secondary list) — a
  // single contact is, by definition, the primary one.
  async function autoPrimaryIfSingle(dealId) {
    const d = (await sql`SELECT primary_contact_id FROM deals WHERE id = ${dealId}`)[0];
    if (!d || d.primary_contact_id) return;
    const secs = await sql`SELECT contact_id FROM deal_contacts WHERE deal_id = ${dealId}`;
    if (secs.length === 1) {
      await sql`UPDATE deals SET primary_contact_id = ${secs[0].contact_id}, last_activity_at = NOW() WHERE id = ${dealId}`;
      await sql`DELETE FROM deal_contacts WHERE deal_id = ${dealId} AND contact_id = ${secs[0].contact_id}`;
    }
  }

  // /deals/:id/contacts — secondary contacts on this deal.
  //   POST  { contactId }                    → link an existing contact
  //   POST  { email, name?, title?, companyId? } → create-and-link in one shot
  //                                            (companyId defaults to the deal's)
  //   DELETE /:contactId                     → unlink (does not delete the contact)
  if (action === 'contacts') {
    await ensureDealContactsTable();
    const dealRow = (await sql`SELECT id, company_id FROM deals WHERE id = ${id}`)[0];
    if (!dealRow) return res.status(404).json({ error: 'Not found' });

    if (req.method === 'POST') {
      const body = req.body || {};
      let contactId = trimOrNull(body.contactId);

      // Create a new contact when no contactId was supplied. Mirrors the
      // shape of POST /api/crm/contacts so the deal page and Gmail extension
      // can both call this in one round-trip when the Cc'd address isn't in
      // the CRM yet.
      if (!contactId) {
        const email = lowerOrNull(body.email);
        if (!email) return res.status(400).json({ error: 'email or contactId is required' });
        const existing = (await sql`SELECT id FROM contacts WHERE email = ${email} LIMIT 1`)[0];
        if (existing) {
          contactId = existing.id;
        } else {
          contactId = makeId('ct');
          const companyId = trimOrNull(body.companyId) || dealRow.company_id || null;
          await sql`
            INSERT INTO contacts (id, email, name, phone, title, company_id, notes, source)
            VALUES (
              ${contactId},
              ${email},
              ${trimOrNull(body.name)},
              ${trimOrNull(body.phone)},
              ${trimOrNull(body.title)},
              ${companyId},
              ${trimOrNull(body.notes)},
              'email-cc'
            )
          `;
        }
      } else {
        const existing = (await sql`SELECT id FROM contacts WHERE id = ${contactId}`)[0];
        if (!existing) return res.status(404).json({ error: 'Contact not found' });
      }

      await sql`
        INSERT INTO deal_contacts (deal_id, contact_id, role, added_by)
        VALUES (${id}, ${contactId}, 'secondary', ${user.email || null})
        ON CONFLICT (deal_id, contact_id) DO NOTHING
      `;
      await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${id}`;
      await autoPrimaryIfSingle(id);

      const contact = (await sql`
        SELECT id, email, name, phone, title, company_id, notes, provisional, source, created_at, updated_at
        FROM contacts WHERE id = ${contactId}
      `)[0];
      return res.status(200).json(serialiseContact(contact));
    }

    if (req.method === 'DELETE') {
      const contactId = trimOrNull(subaction);
      if (!contactId) return res.status(400).json({ error: 'contactId is required' });
      await sql`DELETE FROM deal_contacts WHERE deal_id = ${id} AND contact_id = ${contactId}`;
      await autoPrimaryIfSingle(id);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).end();
  }

  // /deals/:id/files — upload a new file (POST) or list (unused, GET falls through)
  if (action === 'files' && !subaction && req.method === 'POST') {
    const useDrive = driveFilesEnabled();
    if (!useDrive && !process.env.BLOB_READ_WRITE_TOKEN)
      return res.status(503).json({ error: 'File storage not configured' });
    await ensureDealFileDriveColumns();

    const filename = decodeURIComponent(req.headers['x-filename'] || 'upload');
    const mimeType = req.headers['content-type'] || 'application/octet-stream';

    let fileBuffer = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : null;
    if (!fileBuffer) {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      fileBuffer = Buffer.concat(chunks);
    }
    if (!fileBuffer || fileBuffer.length === 0)
      return res.status(400).json({ error: 'No file data received' });
    if (fileBuffer.length > 20 * 1024 * 1024)
      return res.status(413).json({ error: 'File too large (max 20 MB)' });

    const fileId = crypto.randomUUID();

    if (useDrive) {
      let accessToken;
      try { accessToken = await getFreshAccessToken(user.email); }
      catch { return res.status(400).json({ error: 'Connect your Google account (with Drive access) to upload files' }); }
      const reqFolder = req.headers['x-folder-id'] ? String(req.headers['x-folder-id']) : null;
      let driveId, webViewLink, isRoot = true;
      try {
        const root = await dealDriveFolder(accessToken, id);
        let folderId = root;
        if (reqFolder && reqFolder !== root && await isFolderWithin(accessToken, reqFolder, root)) {
          folderId = reqFolder; isRoot = false;
        }
        ({ id: driveId, webViewLink } = await uploadToFolder(accessToken, { folderId, filename, mimeType, buffer: fileBuffer }));
      } catch (err) {
        console.error('[deal files] drive upload failed', err.status, err.message);
        return res.status(502).json({ error: driveErrorHint(err) });
      }
      // Only track root-folder uploads in deal_files (see drive-chunk note).
      if (isRoot) {
        await sql`
          INSERT INTO deal_files (id, deal_id, filename, mime_type, size_bytes, blob_url, drive_file_id, web_view_link, uploaded_by, source)
          VALUES (${fileId}, ${id}, ${filename}, ${mimeType}, ${fileBuffer.length},
                  NULL, ${driveId}, ${webViewLink}, ${user.email}, 'upload')
        `;
      }
      return res.status(201).json({
        id: fileId, filename, mimeType, sizeBytes: fileBuffer.length,
        uploadedBy: user.email, source: 'upload', createdAt: new Date().toISOString(),
      });
    }

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = await put(`deal-files/${id}/${fileId}/${safeName}`, fileBuffer, {
      access: 'private', contentType: mimeType,
    });

    await sql`
      INSERT INTO deal_files (id, deal_id, filename, mime_type, size_bytes, blob_url, blob_pathname, uploaded_by, source)
      VALUES (${fileId}, ${id}, ${filename}, ${mimeType}, ${fileBuffer.length},
              ${blob.url}, ${blob.pathname}, ${user.email}, 'upload')
    `;
    return res.status(201).json({
      id: fileId, filename, mimeType, sizeBytes: fileBuffer.length,
      uploadedBy: user.email, source: 'upload',
      createdAt: new Date().toISOString(),
    });
  }

  // /deals/:id/files/setup-folders — create the standard production subfolder
  // template inside the deal's Drive folder. Idempotent (existing subfolders are
  // reused), so it both backfills older deals and tops up a partial tree.
  if (action === 'files' && subaction === 'setup-folders' && req.method === 'POST') {
    if (!driveFilesEnabled()) return res.status(503).json({ error: 'Google Drive is not configured' });
    let accessToken;
    try { accessToken = await getFreshAccessToken(user.email); }
    catch { return res.status(400).json({ error: 'Connect your Google account (with Drive access) first' }); }
    try {
      const folderId = await dealDriveFolder(accessToken, id);
      await applyFolderTemplate(accessToken, folderId);
      return res.status(200).json({ ok: true, folderId });
    } catch (err) {
      console.error('[deal files] setup-folders failed', err.status, err.message);
      return res.status(502).json({ error: driveErrorHint(err) });
    }
  }

  // /deals/:id/files/folders — the Drive subfolder tree, so the UI can show the
  // folder structure. Best-effort: returns an empty tree on any Drive/auth issue
  // so the Files card still renders.
  if (action === 'files' && subaction === 'folders' && req.method === 'GET') {
    if (!driveFilesEnabled()) return res.status(200).json({ folders: [] });
    const [d] = await sql`SELECT drive_folder_id FROM deals WHERE id = ${id}`;
    if (!d?.drive_folder_id) return res.status(200).json({ folders: [] });
    let accessToken;
    try { accessToken = await getFreshAccessToken(user.email); }
    catch { return res.status(200).json({ folders: [] }); }
    try {
      const folders = await listSubfolderTree(accessToken, d.drive_folder_id);
      return res.status(200).json({ folders });
    } catch (err) {
      console.warn('[deal files] folder tree failed', err.message);
      return res.status(200).json({ folders: [] });
    }
  }

  // /deals/:id/files/contents?folderId= — list one folder's contents (subfolders
  // + files) for the in-card Drive browser. Defaults to the deal's root folder;
  // any folderId must live within the deal's own folder subtree.
  if (action === 'files' && subaction === 'contents' && req.method === 'GET') {
    if (!driveFilesEnabled()) return res.status(200).json({ rootId: null, folderId: null, folders: [], files: [] });
    const [d] = await sql`SELECT drive_folder_id FROM deals WHERE id = ${id}`;
    const root = d?.drive_folder_id || null;
    if (!root) return res.status(200).json({ rootId: null, folderId: null, folders: [], files: [] });
    let accessToken;
    try { accessToken = await getFreshAccessToken(user.email); }
    catch { return res.status(400).json({ error: 'Connect your Google account (with Drive access) first' }); }
    let target = req.query.folderId ? String(req.query.folderId) : root;
    try {
      if (target !== root && !(await isFolderWithin(accessToken, target, root))) target = root;
      const { folders, files } = await listFolderContents(accessToken, target);
      return res.status(200).json({ rootId: root, folderId: target, folders, files });
    } catch (err) {
      console.warn('[deal files] contents failed', err.message);
      return res.status(502).json({ error: driveErrorHint(err) });
    }
  }

  // /deals/:id/files/drive-delete?fileId= — delete a Drive file from the browser.
  // The file must live within the deal's folder subtree. Also clears any
  // deal_files row that referenced it (root-folder uploads keep such a row).
  if (action === 'files' && subaction === 'drive-delete' && req.method === 'DELETE') {
    if (!driveFilesEnabled()) return res.status(400).json({ error: 'Drive files not enabled' });
    await ensureDealFileDriveColumns();
    const driveFileId = req.query.fileId ? String(req.query.fileId) : null;
    if (!driveFileId) return res.status(400).json({ error: 'fileId required' });
    const [d] = await sql`SELECT drive_folder_id FROM deals WHERE id = ${id}`;
    const root = d?.drive_folder_id || null;
    if (!root) return res.status(404).json({ error: 'No Drive folder for this deal' });
    let accessToken;
    try { accessToken = await getFreshAccessToken(user.email); }
    catch { return res.status(400).json({ error: 'Connect your Google account (with Drive access) first' }); }
    try {
      const meta = await getDriveFile(accessToken, driveFileId, 'id,parents');
      const parent = meta?.parents?.[0] || null;
      const within = parent && (parent === root || await isFolderWithin(accessToken, parent, root));
      if (!within) return res.status(403).json({ error: "File is not in this deal's folder" });
      await deleteDriveFile(accessToken, driveFileId);
      await sql`DELETE FROM deal_files WHERE deal_id = ${id} AND drive_file_id = ${driveFileId}`;
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[deal files] drive-delete failed', err.status, err.message);
      return res.status(502).json({ error: driveErrorHint(err) });
    }
  }

  // /deals/:id/files/:fileId — generate a signed download URL (GET) or delete (DELETE)
  if (action === 'files' && subaction && subaction !== 'from-email' && req.method === 'GET') {
    await ensureDealFileDriveColumns();
    const rows = await sql`
      SELECT blob_url, drive_file_id, web_view_link, filename
        FROM deal_files WHERE id = ${subaction} AND deal_id = ${id}
    `;
    if (!rows.length) return res.status(404).json({ error: 'File not found' });
    const f = rows[0];
    if (f.drive_file_id) {
      let link = f.web_view_link;
      if (!link) {
        try { link = await getDriveFileLink(await getFreshAccessToken(user.email), f.drive_file_id); }
        catch (err) { console.error('[deal files] drive link failed', err.message); }
      }
      if (!link) return res.status(502).json({ error: 'Could not resolve Drive link' });
      return res.status(200).json({ downloadUrl: link, filename: f.filename });
    }
    const downloadUrl = await getDownloadUrl(f.blob_url);
    return res.status(200).json({ downloadUrl, filename: f.filename });
  }

  if (action === 'files' && subaction && subaction !== 'from-email' && req.method === 'DELETE') {
    await ensureDealFileDriveColumns();
    const rows = await sql`
      SELECT blob_url, drive_file_id, uploaded_by FROM deal_files WHERE id = ${subaction} AND deal_id = ${id}
    `;
    if (!rows.length) return res.status(404).json({ error: 'File not found' });
    if (rows[0].uploaded_by !== user.email && !hasPermission(await getRole(user.role), 'deals.manage_all')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (rows[0].drive_file_id) {
      try { await deleteDriveFile(await getFreshAccessToken(user.email), rows[0].drive_file_id); }
      catch (err) { console.error('[deal files] drive delete failed', err.message); }
    } else if (rows[0].blob_url) {
      try { await del(rows[0].blob_url); } catch (err) {
        console.error('[deal files] blob delete failed', err.message);
      }
    }
    await sql`DELETE FROM deal_files WHERE id = ${subaction} AND deal_id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  // /deals/:id/files/from-email — copy an email attachment into deal files
  if (action === 'files' && subaction === 'from-email' && req.method === 'POST') {
    const useDrive = driveFilesEnabled();
    if (!useDrive && !process.env.BLOB_READ_WRITE_TOKEN)
      return res.status(503).json({ error: 'File storage not configured' });
    await ensureDealFileDriveColumns();

    const { gmailMessageId, attachmentId, filename, mimeType, size } = req.body || {};
    if (!gmailMessageId || !attachmentId || !filename)
      return res.status(400).json({ error: 'gmailMessageId, attachmentId, filename required' });

    const msgRows = await sql`
      SELECT em.user_email FROM email_messages em
      JOIN email_thread_deals etd ON etd.gmail_thread_id = em.gmail_thread_id
      WHERE em.gmail_message_id = ${gmailMessageId} AND etd.deal_id = ${id}
      LIMIT 1
    `;
    if (!msgRows.length) return res.status(403).json({ error: 'Email not linked to this deal' });

    const accessToken = await getFreshAccessToken(msgRows[0].user_email);

    const attRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(gmailMessageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    if (!attRes.ok) return res.status(502).json({ error: `Gmail fetch failed (${attRes.status})` });
    const { data } = await attRes.json();
    const attBuffer = Buffer.from(data, 'base64url');

    if (attBuffer.length > 20 * 1024 * 1024)
      return res.status(413).json({ error: 'Attachment too large (max 20 MB)' });

    const fileId = crypto.randomUUID();

    if (useDrive) {
      let accessToken;
      try { accessToken = await getFreshAccessToken(user.email); }
      catch { return res.status(400).json({ error: 'Connect your Google account (with Drive access) to save files' }); }
      let driveId, webViewLink;
      try {
        const folderId = await dealDriveFolder(accessToken, id);
        ({ id: driveId, webViewLink } = await uploadToFolder(accessToken, { folderId, filename, mimeType: mimeType || 'application/octet-stream', buffer: attBuffer }));
      } catch (err) {
        console.error('[deal files] drive upload (from-email) failed', err.status, err.message);
        return res.status(502).json({ error: driveErrorHint(err) });
      }
      await sql`
        INSERT INTO deal_files (id, deal_id, filename, mime_type, size_bytes, blob_url, drive_file_id, web_view_link, uploaded_by, source)
        VALUES (${fileId}, ${id}, ${filename}, ${mimeType || null}, ${attBuffer.length},
                NULL, ${driveId}, ${webViewLink}, ${user.email}, 'email')
      `;
      return res.status(201).json({
        id: fileId, filename, mimeType: mimeType || null, sizeBytes: attBuffer.length,
        uploadedBy: user.email, source: 'email', createdAt: new Date().toISOString(),
      });
    }

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = await put(`deal-files/${id}/${fileId}/${safeName}`, attBuffer, {
      access: 'private', contentType: mimeType || 'application/octet-stream',
    });

    await sql`
      INSERT INTO deal_files (id, deal_id, filename, mime_type, size_bytes, blob_url, blob_pathname, uploaded_by, source)
      VALUES (${fileId}, ${id}, ${filename}, ${mimeType || null}, ${attBuffer.length},
              ${blob.url}, ${blob.pathname}, ${user.email}, 'email')
    `;
    return res.status(201).json({
      id: fileId, filename, mimeType: mimeType || null, sizeBytes: attBuffer.length,
      uploadedBy: user.email, source: 'email',
      createdAt: new Date().toISOString(),
    });
  }

  // /deals/:id/files/drive-upload-start — begin a chunked Drive upload. We
  // create a Drive resumable session server-side and hand the browser its URI.
  // The browser then streams the file to us in small chunks (drive-chunk), which
  // we forward to Drive — so large files bypass the serverless body limit
  // without any browser→Google CORS. Drive off → client falls back to Blob.
  if (action === 'files' && subaction === 'drive-upload-start' && req.method === 'POST') {
    if (!driveFilesEnabled()) return res.status(200).json({ enabled: false });
    await ensureDealFileDriveColumns();
    const { filename, mimeType, folderId: reqFolder } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'filename required' });
    let accessToken;
    try { accessToken = await getFreshAccessToken(user.email); }
    catch { return res.status(400).json({ error: 'Connect your Google account (with Drive access) to upload files' }); }
    try {
      const root = await dealDriveFolder(accessToken, id);
      // Upload into the browser's current subfolder when given (and valid),
      // otherwise the deal's root folder.
      let folderId = root;
      if (reqFolder && reqFolder !== root && await isFolderWithin(accessToken, String(reqFolder), root)) {
        folderId = String(reqFolder);
      }
      const uploadUrl = await createResumableUploadSession(accessToken, { folderId, filename, mimeType });
      return res.status(200).json({ enabled: true, uploadUrl, folderId, rootId: root });
    } catch (err) {
      console.error('[deal files] drive upload start failed', err.status, err.message);
      return res.status(502).json({ error: driveErrorHint(err) });
    }
  }

  // /deals/:id/files/drive-chunk — forward one chunk to a Drive resumable
  // session. The browser passes the session URI (X-Upload-Url) and byte range
  // (X-Content-Range); we PUT the bytes to Drive. Drive replies 308 until the
  // final chunk, then 200/201 with the file — at which point we record it.
  if (action === 'files' && subaction === 'drive-chunk' && req.method === 'POST') {
    if (!driveFilesEnabled()) return res.status(400).json({ error: 'Drive files not enabled' });
    await ensureDealFileDriveColumns();
    const uploadUrl = req.headers['x-upload-url'];
    const contentRange = req.headers['x-content-range'];
    const filename = decodeURIComponent(req.headers['x-filename'] || 'upload');
    const mime = req.headers['x-mime'] || 'application/octet-stream';
    const targetFolder = req.headers['x-folder-id'] ? String(req.headers['x-folder-id']) : null;
    if (!uploadUrl || !contentRange) return res.status(400).json({ error: 'Missing upload headers' });

    let chunk = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : null;
    if (!chunk) {
      const chunks = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      chunk = Buffer.concat(chunks);
    }

    let driveRes;
    try {
      driveRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': contentRange, 'Content-Length': String(chunk.length) },
        body: chunk,
        redirect: 'manual',
      });
    } catch (err) {
      console.error('[deal files] drive chunk PUT failed', err.message);
      return res.status(502).json({ error: 'Google Drive upload failed' });
    }

    if (driveRes.status === 308) return res.status(200).json({ done: false });

    if (driveRes.status === 200 || driveRes.status === 201) {
      const f = await driveRes.json().catch(() => ({}));
      const total = Number(String(contentRange).split('/')[1]) || null;
      const fileId = crypto.randomUUID();
      // Only record a deal_files row for root-folder uploads. Files dropped into a
      // subfolder are browsed live from Drive; a row there would just be pruned by
      // the root-only reconcile on the next deal load.
      const [d] = await sql`SELECT drive_folder_id FROM deals WHERE id = ${id}`;
      const root = d?.drive_folder_id || null;
      const isRoot = !targetFolder || targetFolder === root;
      if (isRoot) {
        await sql`
          INSERT INTO deal_files (id, deal_id, filename, mime_type, size_bytes, blob_url, drive_file_id, web_view_link, uploaded_by, source)
          VALUES (${fileId}, ${id}, ${filename}, ${mime}, ${total},
                  NULL, ${f.id || null}, ${f.webViewLink || null}, ${user.email}, 'upload')
        `;
      }
      return res.status(201).json({
        done: true,
        file: {
          id: fileId, filename, mimeType: mime, sizeBytes: total,
          uploadedBy: user.email, source: 'upload', storage: 'drive',
          driveFileId: f.id || null, webViewLink: f.webViewLink || null,
          createdAt: new Date().toISOString(),
        },
      });
    }

    const body = await driveRes.text().catch(() => '');
    console.error('[deal files] drive chunk unexpected', driveRes.status, body.slice(0, 200));
    return res.status(502).json({ error: 'Google Drive upload failed (' + driveRes.status + ')' });
  }

  // /deals/:id/files/drive-status — ask Drive how many bytes a resumable session
  // has received, so the client can resume after an interrupted chunk. Returns
  // { done } (with the recorded file) or { received } = next byte offset.
  if (action === 'files' && subaction === 'drive-status' && req.method === 'POST') {
    if (!driveFilesEnabled()) return res.status(400).json({ error: 'Drive files not enabled' });
    await ensureDealFileDriveColumns();
    const uploadUrl = req.headers['x-upload-url'];
    const total = req.headers['x-total'];
    const filename = decodeURIComponent(req.headers['x-filename'] || 'upload');
    const mime = req.headers['x-mime'] || 'application/octet-stream';
    if (!uploadUrl || !total) return res.status(400).json({ error: 'Missing upload headers' });

    let driveRes;
    try {
      driveRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes */${total}` },
        redirect: 'manual',
      });
    } catch (err) {
      console.error('[deal files] drive status query failed', err.message);
      return res.status(502).json({ error: 'Google Drive status check failed' });
    }

    if (driveRes.status === 200 || driveRes.status === 201) {
      // Already complete — record it if we haven't.
      const f = await driveRes.json().catch(() => ({}));
      const fileId = crypto.randomUUID();
      await sql`
        INSERT INTO deal_files (id, deal_id, filename, mime_type, size_bytes, blob_url, drive_file_id, web_view_link, uploaded_by, source)
        VALUES (${fileId}, ${id}, ${filename}, ${mime}, ${Number(total) || null},
                NULL, ${f.id || null}, ${f.webViewLink || null}, ${user.email}, 'upload')
      `;
      return res.status(200).json({
        done: true,
        file: {
          id: fileId, filename, mimeType: mime, sizeBytes: Number(total) || null,
          uploadedBy: user.email, source: 'upload', storage: 'drive',
          driveFileId: f.id || null, webViewLink: f.webViewLink || null,
          createdAt: new Date().toISOString(),
        },
      });
    }
    if (driveRes.status === 308) {
      const range = driveRes.headers.get('range');
      let received = 0;
      const m = range && range.match(/bytes=0-(\d+)/);
      if (m) received = Number(m[1]) + 1;
      return res.status(200).json({ done: false, received });
    }
    return res.status(502).json({ error: 'Google Drive status check failed (' + driveRes.status + ')' });
  }

  // /deals/:id (no action)
  if (req.method === 'GET') {
    const rows = await sql`SELECT * FROM deals WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const deal = serialiseDeal(rows[0]);
    // The emails query below joins on email_message_deals which is created by
    // a manual migration — self-heal so workspaces that skipped it still load
    // deals without 'relation does not exist'. Likewise deal_contacts and the
    // deal-file Drive columns (so the files query can select drive_file_id).
    await Promise.all([ensureMessageDealsTable(), ensureDealContactsTable(), ensureDealFileDriveColumns(), ensureDealPo()]);

    // Mirror the deal's Drive folder into deal_files (handles files deleted or
    // added directly in Drive) before we read the list below. Best-effort.
    if (driveFilesEnabled() && rows[0].drive_folder_id) {
      try {
        await reconcileDealDriveFiles(id, rows[0].drive_folder_id, await getFreshAccessToken(user.email));
      } catch (err) {
        console.warn('[deal files] drive reconcile skipped', err.message);
      }
    }
    const [proposals, events, tasks, emails, files, comments, secondaryContactRows, primaryContactRows, poFileRows] = await Promise.all([
      sql`
        SELECT p.id, p.data, p.number_year, p.number_seq, p.created_at,
               s.data AS signature_data
          FROM proposals p
          LEFT JOIN signatures s ON s.proposal_id = p.id
         WHERE p.deal_id = ${id}
         ORDER BY p.created_at DESC
      `,
      sql`SELECT id, deal_id, event_type, payload, actor_email, occurred_at FROM deal_events WHERE deal_id = ${id} ORDER BY occurred_at DESC LIMIT 100`,
      sql`
        SELECT t.*,
          (SELECT COALESCE(ARRAY_AGG(ta.user_email ORDER BY ta.assigned_at), '{}')
           FROM task_assignees ta WHERE ta.task_id = t.id) AS assignee_emails
        FROM tasks t
        WHERE t.deal_id = ${id}
        ORDER BY done_at NULLS FIRST, due_at ASC NULLS LAST
        LIMIT 50
      `,
      // Every email_message attached to this deal — either thread-scope (via
      // email_thread_deals, the original M:N) or message-scope (via
      // email_message_deals, added so one email can be filed against several
      // deals while the rest of its conversation lives elsewhere). The two
      // extra boolean-ish columns let the UI choose the right label:
      //   thread_resolved_by = 'manual' OR message_linked = TRUE → "Linked to <deal>"
      //   else                                                    → "Auto-linked to <deal>"
      // Cap at 200 messages — Gmail's typical conversations are well under
      // that and we don't want to bloat the response.
      sql`
        SELECT em.gmail_message_id, em.gmail_thread_id, em.from_email,
               em.to_emails, em.cc_emails, em.subject, em.snippet,
               em.direction, em.sent_at, em.user_email,
               MIN(etd.resolved_by) AS thread_resolved_by,
               BOOL_OR(emd.deal_id IS NOT NULL) AS message_linked
        FROM email_messages em
        LEFT JOIN email_thread_deals etd
               ON etd.gmail_thread_id = em.gmail_thread_id AND etd.deal_id = ${id}
        LEFT JOIN email_message_deals emd
               ON emd.gmail_message_id = em.gmail_message_id AND emd.deal_id = ${id}
        WHERE (etd.deal_id IS NOT NULL OR emd.deal_id IS NOT NULL)
          AND em.internal_only = FALSE
          -- Exclude the bodyless link placeholder rows that attachThreadToDeal
          -- writes (<threadId>:panel-stub); they aren't real emails and would
          -- otherwise show as a "Not found" message in the thread. Mirrors the
          -- filter the other email queries already apply.
          AND em.gmail_message_id NOT LIKE '%-stub'
        GROUP BY em.gmail_message_id, em.gmail_thread_id, em.from_email,
                 em.to_emails, em.cc_emails, em.subject, em.snippet,
                 em.direction, em.sent_at, em.user_email
        ORDER BY em.sent_at DESC
        LIMIT 200
      `,
      sql`SELECT id, filename, mime_type, size_bytes, blob_url, drive_file_id,
               uploaded_by, source, created_at
          FROM deal_files WHERE deal_id = ${id} ORDER BY created_at DESC LIMIT 100`,
      sql`
        SELECT c.id, c.deal_id, c.parent_id, c.body, c.mentions,
               c.created_by, c.created_at, c.updated_at,
               u.name AS author_name, u.avatar AS author_avatar
        FROM deal_comments c
        JOIN users u ON u.email = c.created_by
        WHERE c.deal_id = ${id}
        ORDER BY c.created_at ASC
      `,
      sql`
        SELECT c.id, c.email, c.name, c.phone, c.title, c.company_id, c.notes,
               c.provisional, c.source, c.created_at, c.updated_at,
               dc.added_at, dc.added_by
        FROM deal_contacts dc
        JOIN contacts c ON c.id = dc.contact_id
        WHERE dc.deal_id = ${id} AND dc.role = 'secondary'
        ORDER BY dc.added_at ASC
      `,
      deal.primaryContactId ? sql`
        SELECT id, email, name, phone, title, company_id, notes, provisional, source, created_at, updated_at
        FROM contacts WHERE id = ${deal.primaryContactId}
      ` : Promise.resolve([]),
      sql`SELECT id, filename, mime_type, size_bytes, uploaded_by, created_at
            FROM deal_po_files WHERE deal_id = ${id} ORDER BY created_at DESC`,
    ]);

    // Load reactions for all comments in one query and merge into comments.
    // Wrapped in try/catch so a missing table (pre-migration) doesn't break the endpoint.
    const commentIds = comments.map(c => c.id);
    const reactionsMap = {};
    try {
      const reactionRows = commentIds.length ? await sql`
        SELECT comment_id, emoji, ARRAY_AGG(user_email) AS users, COUNT(*) AS cnt
        FROM deal_comment_reactions
        WHERE comment_id = ANY(${commentIds})
        GROUP BY comment_id, emoji
      ` : [];
      for (const r of reactionRows) {
        if (!reactionsMap[r.comment_id]) reactionsMap[r.comment_id] = {};
        reactionsMap[r.comment_id][r.emoji] = { count: Number(r.cnt), users: r.users };
      }
    } catch (_) { /* table not yet migrated — reactions load as empty */ }

    // Production videos (project_videos). Guarded so a workspace that hasn't
    // applied the production migration still loads the deal page.
    let videos = [];
    try {
      const vrows = await sql`
        SELECT pv.*,
               (SELECT COALESCE(ARRAY_AGG(va.user_email ORDER BY va.assigned_at), '{}')
                  FROM video_assignees va WHERE va.video_id = pv.id) AS producer_emails,
               (SELECT MAX(rv.version_number)
                  FROM revision_versions rv WHERE rv.video_id = pv.revision_video_id) AS revision_round
          FROM project_videos pv WHERE pv.deal_id = ${id} ORDER BY pv.sort_order, pv.created_at`;
      videos = vrows.map(v => ({
        id: v.id, dealId: v.deal_id, title: v.title, status: v.status,
        productionPhase: v.production_phase || null,
        productionStage: v.production_stage || null,
        productionStageChangedAt: v.production_stage_changed_at || null,
        paymentTerms: v.payment_terms || null,
        videoLength: v.video_length || null,
        deliveryDeadline: v.delivery_deadline || null,
        textDirectionDeadline: v.text_direction_deadline || null,
        producerEmail: v.producer_email || null,
        producerEmails: Array.isArray(v.producer_emails) && v.producer_emails.length
          ? v.producer_emails : (v.producer_email ? [v.producer_email] : []),
        sortOrder: v.sort_order, revisionVideoId: v.revision_video_id || null,
        revisionRound: v.revision_round != null ? Number(v.revision_round) : null,
        createdAt: v.created_at, updatedAt: v.updated_at || null,
      }));
    } catch (_) { /* project_videos not yet migrated */ }

    // Deal-level producers (team).
    let dealProducerEmails = deal.producerEmail ? [deal.producerEmail] : [];
    try {
      const prows = await sql`SELECT user_email FROM deal_assignees WHERE deal_id = ${id} ORDER BY assigned_at`;
      if (prows.length) dealProducerEmails = prows.map(r => r.user_email);
    } catch (_) { /* deal_assignees not yet migrated */ }

    // Recover any orphaned (Gmail-composed) tracking rows for this deal's sends
    // first, so the lookups below can find a teammate's tracked emails even when
    // the extension's /link step never filled in the Gmail ids.
    await backfillDealTrackingIds(emails);

    // Open/click tracking for this deal's outbound threads, team-wide (not just
    // the viewer's own sends). Keyed by thread; degrades to {} pre-migration.
    const emailTracking = await trackingForDealThreads(
      Array.from(new Set(emails.map(e => e.gmail_thread_id).filter(Boolean)))
    );
    // Per-message tracking too, so an expanded thread can show each sent email's
    // own opens (and the "last email" eye) rather than only the thread total.
    const messageTracking = await trackingForMessages(
      Array.from(new Set(emails.map(e => e.gmail_message_id).filter(Boolean)))
    );

    // Marketing lead source is for sales/management — never send it to producer
    // or copywriter accounts (they don't see marketing attribution).
    const isProducerRole = user?.role === 'producer' || user?.role === 'copywriter';
    const leadSource = isProducerRole ? null : await dealLeadSource(deal);

    // Payment plan from the signed proposal ('5050' | 'full' | 'po') — labels the
    // project's "paid" badge (e.g. "Deposit paid" for a 50/50 deal).
    let paymentOption = null;
    for (const p of proposals) {
      let sd = p.signature_data;
      if (typeof sd === 'string') { try { sd = JSON.parse(sd); } catch { sd = null; } }
      const opt = sd && sd.paymentOption;
      if (opt) { paymentOption = opt; break; }
    }

    return res.status(200).json({
      ...deal,
      paymentOption,
      // First-touch marketing attribution for the lead that became this deal
      // (null if it didn't come from the quote form), incl. a returning-client flag.
      leadSource,
      // Whether deal files are Drive-backed (drives the client upload path/cap),
      // and the deal's Drive folder id once one's been created (for an "open
      // folder" link). The folder is created lazily on first upload.
      driveFiles: driveFilesEnabled(),
      driveFolderId: rows[0].drive_folder_id || null,
      producerEmails: dealProducerEmails,
      videos,
      proposals: proposals.map(p => ({
        id: p.id,
        clientName: p.data?.clientName || null,
        contactBusinessName: p.data?.contactBusinessName || null,
        basePrice: p.data?.basePrice || null,
        // Project value ex VAT, reflecting any selected extras / discounts
        // from the signature when the proposal is signed. Falls back to the
        // proposal's basePrice when there's no signature yet. Excludes the
        // ongoing Partner Programme subscription so it represents the
        // one-off project sale only.
        totalExVat: computeProposalTotalExVat(p.data, p.signature_data),
        signed: !!p.signature_data,
        number: p.number_year && p.number_seq ? { year: p.number_year, seq: p.number_seq } : null,
        createdAt: p.created_at,
      })),
      events: events.map(e => ({
        id: Number(e.id),
        eventType: e.event_type,
        payload: e.payload || {},
        actorEmail: e.actor_email || null,
        occurredAt: e.occurred_at,
      })),
      tasks: tasks.map(serialiseTask),
      emails: emails.map(em => ({
        gmailMessageId: em.gmail_message_id,
        gmailThreadId: em.gmail_thread_id,
        fromEmail: em.from_email || null,
        toEmails: em.to_emails || [],
        ccEmails: em.cc_emails || [],
        subject: em.subject || null,
        snippet: em.snippet || null,
        direction: em.direction,
        sentAt: em.sent_at,
        userEmail: em.user_email,
        // Manual link: the user explicitly attached this message/thread to
        // this deal via the inbox "Add to another deal" flow. Auto link: the
        // inbound resolver picked it up (header / contact / domain match).
        // Used by the row's "(Auto-)Linked to <deal>" label.
        manuallyLinked: em.thread_resolved_by === 'manual' || em.message_linked === true,
        // Streak-style open/click tracking for this thread's outbound sends.
        // Null for untracked threads / inbound-only; the UI gates on direction.
        tracking: emailTracking[em.gmail_thread_id] || null,
        // This individual message's own tracking (drives the per-email eye in an
        // expanded thread). Null for inbound / untracked messages.
        messageTracking: messageTracking[em.gmail_message_id] || null,
      })),
      files: files.map(f => ({
        id: f.id, filename: f.filename, mimeType: f.mime_type || null,
        sizeBytes: f.size_bytes || null, blobUrl: f.blob_url,
        storage: f.drive_file_id ? 'drive' : 'blob',
        uploadedBy: f.uploaded_by || null, source: f.source,
        createdAt: f.created_at,
      })),
      comments: comments.map(c => serialiseComment(c, reactionsMap[c.id] || {})),
      secondaryContacts: secondaryContactRows.map(r => ({
        ...serialiseContact(r),
        addedAt: r.added_at,
        addedBy: r.added_by || null,
      })),
      primaryContact: primaryContactRows[0] ? serialiseContact(primaryContactRows[0]) : null,
      // Purchase-order tracking. isPo = any signed proposal took the PO route.
      // number/receivedAt come from the deal; files are the uploaded PO docs.
      purchaseOrder: {
        isPo: proposals.some(p => p.signature_data && p.signature_data.paymentOption === 'po'),
        number: rows[0].po_number || null,
        receivedAt: rows[0].po_received_at || null,
        files: poFileRows.map(f => ({
          id: f.id, filename: f.filename, mimeType: f.mime_type || null,
          sizeBytes: f.size_bytes != null ? Number(f.size_bytes) : null,
          uploadedBy: f.uploaded_by || null, createdAt: f.created_at,
        })),
      },
    });
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const cur = (await sql`
      SELECT id, title, company_id, primary_contact_id, owner_email, stage, stage_changed_at,
             value, vat_rate, expected_close_at, lost_reason, notes, overview_video_url, last_activity_at, created_at, updated_at
      FROM deals WHERE id = ${id}
    `)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const next = {
      title:               'title'             in body ? (trimOrNull(body.title) || cur.title) : cur.title,
      company_id:          'companyId'         in body ? (trimOrNull(body.companyId) || null) : cur.company_id,
      primary_contact_id:  'primaryContactId'  in body ? (trimOrNull(body.primaryContactId) || null) : cur.primary_contact_id,
      owner_email:         'ownerEmail'        in body ? (trimOrNull(body.ownerEmail) || null) : cur.owner_email,
      value:               'value'             in body ? numberOrNull(body.value) : cur.value,
      vat_rate:            'vatRate'           in body ? numberOrNull(body.vatRate) : cur.vat_rate,
      expected_close_at:   'expectedCloseAt'   in body ? (trimOrNull(body.expectedCloseAt)) : cur.expected_close_at,
      notes:               'notes'             in body ? trimOrNull(body.notes) : cur.notes,
      overview_video_url:  'overviewVideoUrl'  in body ? trimOrNull(body.overviewVideoUrl) : cur.overview_video_url,
    };
    await sql`
      UPDATE deals SET
        title = ${next.title},
        company_id = ${next.company_id},
        primary_contact_id = ${next.primary_contact_id},
        owner_email = ${next.owner_email},
        value = ${next.value},
        vat_rate = ${next.vat_rate},
        expected_close_at = ${next.expected_close_at},
        notes = ${next.notes},
        overview_video_url = ${next.overview_video_url},
        last_activity_at = NOW(),
        updated_at = NOW()
      WHERE id = ${id}
    `;
    // When the primary contact changes, keep the two lists consistent: the new
    // primary shouldn't also sit in the secondary list, and the old primary is
    // demoted to a secondary so it isn't dropped from the deal. Lets "Make
    // primary" be a single primaryContactId PATCH from the contact editor.
    if ('primaryContactId' in body && next.primary_contact_id !== cur.primary_contact_id) {
      await ensureDealContactsTable();
      if (next.primary_contact_id) {
        await sql`DELETE FROM deal_contacts WHERE deal_id = ${id} AND contact_id = ${next.primary_contact_id}`;
      }
      if (cur.primary_contact_id && cur.primary_contact_id !== next.primary_contact_id) {
        await sql`
          INSERT INTO deal_contacts (deal_id, contact_id, role, added_by)
          VALUES (${id}, ${cur.primary_contact_id}, 'secondary', ${user.email || null})
          ON CONFLICT (deal_id, contact_id) DO NOTHING`;
      }
    }
    // Producers (team): accept the array or legacy single; keep producer_email
    // populated with the first for back-compat.
    if ('producerEmails' in body || 'producerEmail' in body) {
      const producers = readDealProducerEmails(body);
      await setDealAssignees(id, producers);
      await sql`UPDATE deals SET producer_email = ${producers[0] || null} WHERE id = ${id}`;
    }
    // Manual production start date (PM-set; nullable). Self-heal the column so the
    // edit works on a workspace that hasn't hit a production path yet.
    if ('productionStartDate' in body) {
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS production_start_date DATE`.catch(() => {});
      await sql`UPDATE deals SET production_start_date = ${trimOrNull(body.productionStartDate)}, updated_at = NOW() WHERE id = ${id}`;
    }
    const rows = await sql`
      SELECT id, title, company_id, primary_contact_id, owner_email, stage, stage_changed_at,
             value, vat_rate, expected_close_at, lost_reason, notes, overview_video_url, last_activity_at, created_at, updated_at, producer_email
      FROM deals WHERE id = ${id}
    `;
    const producerRows = await sql`SELECT user_email FROM deal_assignees WHERE deal_id = ${id} ORDER BY assigned_at`;
    const producerEmails = producerRows.length
      ? producerRows.map(r => r.user_email)
      : (rows[0].producer_email ? [rows[0].producer_email] : []);
    return res.status(200).json({ ...serialiseDeal(rows[0]), producerEmails });
  }

  if (req.method === 'DELETE') {
    if (!hasPermission(await getRole(user.role), 'deals.manage_all')) {
      return res.status(403).json({ error: 'You do not have permission to delete deals' });
    }
    await sql`DELETE FROM deals WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}

// Alert the project managers (and admins/directors, per their prefs) that a
// deal has been marked "Good to go" and is now a production project. Broadcast
// on the general (Updates) bell + email; the person who clicked is excluded —
// they know they just did it. Best-effort: the caller wraps this in try/catch.
async function notifyGoodToGo(deal, user) {
  const title = deal.title || deal.id;
  const link = `${APP_URL}/crm?deal=${deal.id}`;
  const actor = user?.name || user?.email || 'Someone';
  await sendNotification('project.good_to_go', {
    subject: `🟢 Good to go: ${title}`,
    html: `<p style="font-size:15px"><strong>${actor}</strong> marked <strong>${title}</strong> good to go — it’s now in production and ready to pick up.</p>`
        + `<p><a href="${link}">Open the project</a></p>`,
    text: `${actor} marked “${title}” good to go — it’s now in production and ready to pick up. ${link}`,
    excludeEmails: user?.email ? [user.email] : null,
    inApp: {
      title: `Good to go: ${title}`,
      body: `${actor} moved this deal into production.`,
      link: `#/deal/${deal.id}`,
    },
  });
}

// Compute the ex-VAT value of a proposal that best reflects the actual
// deal value at this point in time:
//   - Signed proposals: use signature.amountBreakdown.projectExVat when
//     the partner programme split is present (so we exclude the recurring
//     subscription), or signature.total/(1+vatRate) for the simple case.
//   - Unsigned proposals: fall back to basePrice (no extras selected yet).
export function computeProposalTotalExVat(proposalData, signatureData) {
  if (signatureData?.amountBreakdown?.projectExVat != null) {
    const v = Number(signatureData.amountBreakdown.projectExVat);
    if (Number.isFinite(v)) return v;
  }
  if (signatureData?.total != null && Number.isFinite(Number(signatureData.total))) {
    const vatRate = Number(proposalData?.vatRate) || 0;
    return Number(signatureData.total) / (1 + vatRate);
  }
  return proposalData?.basePrice ?? null;
}

export function serialiseDeal(r) {
  const out = {
    id: r.id,
    title: r.title,
    companyId: r.company_id || null,
    primaryContactId: r.primary_contact_id || null,
    ownerEmail: r.owner_email || null,
    stage: r.stage,
    stageChangedAt: r.stage_changed_at,
    value: r.value === null || r.value === undefined ? null : Number(r.value),
    expectedCloseAt: r.expected_close_at || null,
    lostReason: r.lost_reason || null,
    notes: r.notes || null,
    lastActivityAt: r.last_activity_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  // Only carried on rows that select it (detail SELECT *, the PATCH returning
  // list); omitted on partial selects so the optimistic merge never blanks it.
  if ('overview_video_url' in r) out.overviewVideoUrl = r.overview_video_url || null;
  // Orthogonal "hot" warm-lead flag. Carried on SELECT * rows (list + detail +
  // annotateDeals); omitted on partial selects so the optimistic merge never
  // blanks it on a stage move / edit.
  if ('hot' in r) out.hot = !!r.hot;
  // Per-deal VAT rate (fraction; 0.2 = 20%). Carried on SELECT * + the create/
  // PATCH returns; guarded so a partial select never blanks it in the cache.
  if ('vat_rate' in r) out.vatRate = r.vat_rate == null ? null : Number(r.vat_rate);
  // PO tracking fields — carried on SELECT * rows (deals list + detail). Omitted
  // on partial selects so a stage move / edit never blanks them in the cache.
  if ('po_number' in r) { out.poNumber = r.po_number || null; out.poReceivedAt = r.po_received_at || null; }
  // Production fields are only carried on rows selected with them (the deals
  // list and detail use SELECT *). Partial selects — a sales-stage move, a
  // deal edit — omit these keys so they're never blanked out in the cached
  // deal by the optimistic merge.
  if ('production_phase' in r) {
    out.productionPhase           = r.production_phase || null;
    out.productionStage           = r.production_stage || null;
    out.productionEnteredAt        = r.production_entered_at || null;
    out.productionStartDate        = r.production_start_date || null;
    out.productionStageChangedAt   = r.production_stage_changed_at || null;
    out.productionCredits          = r.production_credits == null ? 0 : Number(r.production_credits);
    out.producerEmail              = r.producer_email || null;
    out.paymentTerms               = r.payment_terms || null;
    out.deliveryDeadline           = r.delivery_deadline || null;
    out.textDirectionDeadline      = r.text_direction_deadline || null;
    out.videoLength                = r.video_length || null;
  }
  return out;
}
