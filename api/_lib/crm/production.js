// Production board API. VIDEOS move through the board; a project (deal) is the
// container that groups a client's videos. Routed from api/crm/[...slug].js as
// `case 'production'`.
//
//   GET    /api/crm/production                     — all videos for the board (joined to project + customer)
//   POST   /api/crm/production   { title, companyId?, ... }   — create a project (deal) + first video
//   POST   /api/crm/production/:dealId/enter                  — manual "Add to production"
//   POST   /api/crm/production/:dealId/credits   { delta }    — adjust the project credit balance
//   POST   /api/crm/production/:dealId/videos    { title?, fromCredit? } — add a video
//   GET    /api/crm/production/video/:videoId                 — one video + project context
//   POST   /api/crm/production/video/:videoId/move  { phase, stage }     — move the video on the board
//   PATCH  /api/crm/production/video/:videoId    { title?, status?, paymentTerms?, videoLength?, deliveryDeadline?, textDirectionDeadline?, producerEmail?, sortOrder? }
//   DELETE /api/crm/production/video/:videoId
//   POST   /api/crm/production/video/:videoId/send-for-review — hand off to Revisions
import crypto from 'node:crypto';
import { put, del, getDownloadUrl } from '@vercel/blob';
import { handleUpload } from '@vercel/blob/client';
import { waitUntil } from '@vercel/functions';
import sql from '../db.js';
import { makeId, trimOrNull, numberOrNull, driveFilesEnabled } from './shared.js';
import { serialiseDeal, ensureDealFileDriveColumns, dealDriveFolder, driveErrorHint } from './deals.js';
import { getFreshAccessToken } from './gmail.js';
import { uploadToFolder, ensureSubfolderByPath, ensureNamedSubfolder, deleteDriveFile } from '../googleDrive.js';
import { enterProduction, ensureProductionSchema } from '../production.js';
import { isValidStage } from '../dealStage.js';
import { isValidProductionStage, isValidVideoStatus, isValidPaymentTerms, isValidMilestone, VIDEO_MILESTONE_BY_ID, stageOrderIndex, previewKindForStage, FIRST_PRODUCTION } from '../productionStages.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { archiveRecord } from './recycleBin.js';

// Where scripts live inside a deal's Drive folder (from the FOLDER_TEMPLATE in
// googleDrive.js).
const SCRIPT_FOLDER_PATH = ['2. Pre-Production', '1. Script and Text Direction'];

// Milestone content uploads share the public Revisions Blob store (so they
// preview inline) and best-effort sync into these Drive subfolders.
const REVISION_BLOB_TOKEN =
  process.env.REVISION_BLOB_READ_WRITE_TOKEN || process.env.REVIEW_BLOB_READ_WRITE_TOKEN;
const MILESTONE_DRIVE_PATH = {
  script:     ['2. Pre-Production', '1. Script and Text Direction'],
  storyboard: ['2. Pre-Production', '2. Storyboards'],
  video:      ['3. Video'],
};
// Reference imagery uploaded under the combined Script & Text Direction
// milestone is filed separately from the script doc, by file type.
const REFERENCE_IMAGERY_PATH = ['1. Resources', 'Reference Imagery'];

// Public base for client revision share links (matches RevisionsView.jsx).
const REVISION_PUBLIC_BASE = 'https://app.squideo.com';

// Self-heal: columns added later for "do not auto-relink by title" state.
// When the producer explicitly links or unlinks a revision OR storyboard via
// the video page, we stamp the matching timestamp; loadVideo's title-based
// auto-link then skips locked rows so the next page load doesn't silently
// undo their choice.
let linkLockColumnsEnsured = null;
async function ensureLinkLockColumns() {
  if (linkLockColumnsEnsured) return linkLockColumnsEnsured;
  linkLockColumnsEnsured = (async () => {
    try {
      await sql`ALTER TABLE project_videos
        ADD COLUMN IF NOT EXISTS revision_link_locked_at  TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS storyboard_link_locked_at TIMESTAMPTZ`;
    } catch (err) {
      linkLockColumnsEnsured = null;
      console.warn('[production] ensureLinkLockColumns failed', err.message);
    }
  })();
  return linkLockColumnsEnsured;
}

// Board / single-video query: a video joined to its project (deal) + customer.
const VIDEO_SELECT = (whereSql) => sql`
  SELECT pv.*, d.title AS project_title, c.name AS company_name,
         d.drive_folder_id AS drive_folder_id,
         d.production_entered_at AS production_entered_at,
         d.production_start_date AS production_start_date,
         (SELECT COALESCE(ARRAY_AGG(va.user_email ORDER BY va.assigned_at), '{}')
            FROM video_assignees va WHERE va.video_id = pv.id) AS producer_emails,
         (SELECT p.number_year || '-' || lpad(p.number_seq::text, 3, '0')
            FROM proposals p
           WHERE p.deal_id = d.id AND p.number_seq IS NOT NULL
           ORDER BY p.number_seq ASC LIMIT 1) AS project_number,
         (SELECT MAX(rv.version_number)
            FROM revision_versions rv
           WHERE rv.video_id = pv.revision_video_id) AS revision_round
    FROM project_videos pv
    JOIN deals d ON d.id = pv.deal_id
    LEFT JOIN companies c ON c.id = d.company_id
   ${whereSql}
`;

// The payment plan comes from the deal's signed proposal (signature_data.
// paymentOption → '5050' | 'full' | 'po'). Read-only on the video/board. Parsed
// in JS (never in SQL) so a malformed signature_data row can never break the
// board query. signature_data may arrive parsed (jsonb) or as a JSON string.
function parseSignature(sd) {
  if (!sd) return null;
  if (typeof sd === 'object') return sd;
  try { return JSON.parse(sd); } catch { return null; }
}
async function paymentOptionForDeal(dealId) {
  if (!dealId) return null;
  try {
    const [row] = await sql`
      SELECT s.data AS signature_data
        FROM proposals p
        JOIN signatures s ON s.proposal_id = p.id
       WHERE p.deal_id = ${dealId}
       ORDER BY s.signed_at DESC NULLS LAST LIMIT 1`;
    return parseSignature(row?.signature_data)?.paymentOption || null;
  } catch { return null; }
}
async function paymentOptionMap(dealIds) {
  const map = new Map();
  if (!dealIds.length) return map;
  try {
    const rows = await sql`
      SELECT DISTINCT ON (p.deal_id) p.deal_id, s.data AS signature_data
        FROM proposals p
        JOIN signatures s ON s.proposal_id = p.id
       WHERE p.deal_id = ANY(${dealIds})
       ORDER BY p.deal_id, s.signed_at DESC NULLS LAST`;
    for (const r of rows) map.set(r.deal_id, parseSignature(r.signature_data)?.paymentOption || null);
  } catch { /* leave map empty */ }
  return map;
}

export async function productionRoute(req, res, id, action, user, subaction = null) {
  if (!hasPermission(await getRole(user.role), 'production.access')) {
    return res.status(403).json({ error: 'You do not have permission to access production' });
  }
  await ensureProductionSchema();
  // The board query selects deals.drive_folder_id — make sure the column exists.
  await ensureDealFileDriveColumns();

  // ── Board list + project creation ─────────────────────────────────────────
  if (!id) {
    // GET: every video on the board (the Projects overview is derived from this
    // same list client-side, grouping by project).
    if (req.method === 'GET') {
      // A deal only reaches the board once someone marks it "Good to go" (see
      // the deals route's good-to-go action) — payment alone no longer enters
      // production, so there's no paid-deal backfill to run here.
      const rows = await sql`
        SELECT pv.*, d.title AS project_title, c.name AS company_name,
               d.production_entered_at AS production_entered_at,
               d.production_start_date AS production_start_date,
               (SELECT COALESCE(ARRAY_AGG(va.user_email ORDER BY va.assigned_at), '{}')
                  FROM video_assignees va WHERE va.video_id = pv.id) AS producer_emails
          FROM project_videos pv
          JOIN deals d ON d.id = pv.deal_id
          LEFT JOIN companies c ON c.id = d.company_id
         WHERE pv.production_phase IS NOT NULL
         ORDER BY pv.sort_order, pv.created_at
      `;
      const videos = rows.map(serialiseVideo);
      const pmap = await paymentOptionMap([...new Set(videos.map(v => v.dealId).filter(Boolean))]);
      for (const v of videos) v.paymentOption = pmap.get(v.dealId) || null;
      return res.status(200).json(videos);
    }

    // POST: create a project (deal) from scratch + its first video. Manually-
    // created projects default to the 'paid' sales stage (committed work).
    if (req.method !== 'POST') return res.status(405).end();
    const body = req.body || {};
    const title = trimOrNull(body.title);
    if (!title) return res.status(400).json({ error: 'title is required' });
    const newId = makeId('deal');
    const stage = isValidStage(body.stage) ? body.stage : 'paid';
    await sql`
      INSERT INTO deals (id, title, company_id, primary_contact_id, owner_email, producer_email, stage, value)
      VALUES (${newId}, ${title}, ${trimOrNull(body.companyId)}, ${trimOrNull(body.primaryContactId)},
              ${trimOrNull(body.ownerEmail) || user.email}, ${trimOrNull(body.producerEmail)},
              ${stage}, ${numberOrNull(body.value)})
    `;
    await sql`
      INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
      VALUES (${newId}, 'deal_created', ${JSON.stringify({ title, stage, source: 'production-manual' })}, ${user.email || null})
    `;
    await enterProduction(newId, { source: 'manual-create', actorEmail: user.email });
    const row = (await sql`SELECT * FROM deals WHERE id = ${newId}`)[0];
    return res.status(201).json(serialiseDeal(row));
  }

  // ── Video-scoped: /production/video/:videoId[/move|/send-for-review] ───────
  if (id === 'video') {
    const videoId = action;
    if (!videoId) return res.status(400).json({ error: 'videoId required' });

    if (subaction === 'send-for-review') {
      if (req.method !== 'POST') return res.status(405).end();
      return sendVideoForReview(res, videoId, user);
    }
    if (subaction === 'link-revision') {
      if (req.method !== 'POST') return res.status(405).end();
      return linkRevisionVideo(req, res, videoId, user);
    }
    if (subaction === 'unlink-revision') {
      if (req.method !== 'POST') return res.status(405).end();
      return unlinkRevisionVideo(res, videoId);
    }
    if (subaction === 'link-storyboard') {
      if (req.method !== 'POST') return res.status(405).end();
      return linkStoryboard(req, res, videoId, user);
    }
    if (subaction === 'unlink-storyboard') {
      if (req.method !== 'POST') return res.status(405).end();
      return unlinkStoryboard(res, videoId);
    }
    if (subaction === 'send-storyboard-for-review') {
      if (req.method !== 'POST') return res.status(405).end();
      return sendStoryboardForReview(res, videoId, user);
    }
    if (subaction === 'move') {
      if (req.method !== 'POST') return res.status(405).end();
      return moveVideo(req, res, videoId, user);
    }
    if (subaction === 'milestone') {
      if (req.method !== 'POST') return res.status(405).end();
      return setMilestone(req, res, videoId, user);
    }
    if (subaction === 'script') {
      if (req.method === 'POST')   return uploadScript(req, res, videoId, user);
      if (req.method === 'DELETE') return deleteScript(req, res, videoId, user);
      return res.status(405).end();
    }
    if (subaction === 'milestone-asset') {
      if (req.method === 'POST') {
        if (req.query?.register) return registerMilestoneAsset(req, res, videoId, user);
        return milestoneAssetUploadToken(req, res); // @vercel/blob client-upload handshake
      }
      if (req.method === 'DELETE') return deleteMilestoneAsset(req, res, videoId, user);
      return res.status(405).end();
    }
    if (req.method === 'GET') {
      const [row] = await VIDEO_SELECT(sql`WHERE pv.id = ${videoId}`);
      if (!row) return res.status(404).json({ error: 'Video not found' });
      return res.status(200).json(await withVideoExtras(serialiseVideo(row)));
    }
    if (req.method === 'PATCH') return updateVideo(req, res, videoId);
    if (req.method === 'DELETE') {
      const [vid] = await sql`SELECT * FROM project_videos WHERE id = ${videoId}`;
      if (!vid) return res.status(404).json({ error: 'Video not found' });
      // Archive the video + its cascade children (parent first) so the delete is
      // undoable via /api/crm/restore/:videoId. Best-effort — a failed archive
      // must not block the delete itself.
      try {
        const [milestones, assets, scripts, assignees] = await Promise.all([
          sql`SELECT * FROM video_milestones WHERE video_id = ${videoId}`,
          sql`SELECT * FROM video_milestone_assets WHERE video_id = ${videoId}`,
          sql`SELECT * FROM video_scripts WHERE video_id = ${videoId}`,
          sql`SELECT * FROM video_assignees WHERE video_id = ${videoId}`,
        ]);
        await archiveRecord('project_video', videoId, [
          { table: 'project_videos', row: vid },
          ...milestones.map((row) => ({ table: 'video_milestones', row })),
          ...assets.map((row) => ({ table: 'video_milestone_assets', row })),
          ...scripts.map((row) => ({ table: 'video_scripts', row })),
          ...assignees.map((row) => ({ table: 'video_assignees', row })),
        ], user.email);
      } catch (err) {
        console.error('[production] archive before delete failed', err.message);
      }
      await sql`DELETE FROM project_videos WHERE id = ${videoId}`; // cascades children
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  }

  // ── Project-scoped: /production/:dealId/{enter,credits,videos} ─────────────
  const dealId = id;
  const deal = (await sql`SELECT id FROM deals WHERE id = ${dealId}`)[0];
  if (!deal) return res.status(404).json({ error: 'Deal not found' });

  // Manual "Add to production" for a paid deal that wasn't auto-added.
  if (action === 'enter') {
    if (req.method !== 'POST') return res.status(405).end();
    const result = await enterProduction(dealId, { source: 'manual', actorEmail: user.email });
    const row = (await sql`SELECT * FROM deals WHERE id = ${dealId}`)[0];
    return res.status(200).json({ ...serialiseDeal(row), entered: result.entered });
  }

  // Adjust the project's pre-paid credit balance (+N to add, -N to spend).
  if (action === 'credits') {
    if (req.method !== 'POST') return res.status(405).end();
    const delta = Math.trunc(Number((req.body || {}).delta));
    if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: 'delta must be a non-zero integer' });
    const row = (await sql`
      UPDATE deals
         SET production_credits = GREATEST(0, COALESCE(production_credits, 0) + ${delta}), updated_at = NOW()
       WHERE id = ${dealId}
       RETURNING production_credits
    `)[0];
    return res.status(200).json({ ok: true, productionCredits: row.production_credits });
  }

  // Add a video (lands at Pre-Production / New Project), optionally from credit.
  if (action === 'videos') {
    if (req.method !== 'POST') return res.status(405).end();
    const body = req.body || {};
    const [{ next }] = await sql`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM project_videos WHERE deal_id = ${dealId}`;
    const title = trimOrNull(body.title) || ('Video ' + (Number(next) + 1));

    if (body.fromCredit === true) {
      const dec = await sql`
        UPDATE deals SET production_credits = production_credits - 1, updated_at = NOW()
         WHERE id = ${dealId} AND production_credits > 0
         RETURNING production_credits
      `;
      if (!dec.length) return res.status(400).json({ error: 'No credits available' });
    }

    const vid = makeId('pvid');
    await sql`
      INSERT INTO project_videos
        (id, deal_id, title, status, sort_order, production_phase, production_stage, production_stage_changed_at, created_by)
      VALUES
        (${vid}, ${dealId}, ${title}, 'not_started', ${next}, ${FIRST_PRODUCTION.phase}, ${FIRST_PRODUCTION.stage}, NOW(), ${user.email || null})
    `;
    // Second and later videos get their own "V2", "V3", … folder in the deal's
    // Drive (the first video uses the standard template). Best-effort and
    // detached so a Drive blip never blocks adding the video.
    const videoNumber = Number(next) + 1;
    if (videoNumber >= 2 && driveFilesEnabled() && user.email) {
      waitUntil((async () => {
        try {
          const accessToken = await getFreshAccessToken(user.email);
          const root = await dealDriveFolder(accessToken, dealId);
          await ensureNamedSubfolder(accessToken, root, 'V' + videoNumber);
        } catch (err) {
          console.error('[videos] could not create V' + videoNumber + ' Drive folder', err?.status, err?.message);
        }
      })());
    }

    const [row] = await VIDEO_SELECT(sql`WHERE pv.id = ${vid}`);
    return res.status(201).json(serialiseVideo(row));
  }

  return res.status(405).end();
}

// Move a video to a new phase/stage on the board.
async function moveVideo(req, res, videoId, user) {
  const { phase, stage } = req.body || {};
  if (!isValidProductionStage(phase, stage)) return res.status(400).json({ error: 'Invalid phase/stage' });
  const cur = (await sql`SELECT deal_id, production_phase, production_stage FROM project_videos WHERE id = ${videoId}`)[0];
  if (!cur) return res.status(404).json({ error: 'Video not found' });
  if (cur.production_phase !== phase || cur.production_stage !== stage) {
    await sql`
      UPDATE project_videos
         SET production_phase = ${phase}, production_stage = ${stage}, production_stage_changed_at = NOW(), updated_at = NOW()
       WHERE id = ${videoId}
    `;
    await sql`
      INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
      VALUES (${cur.deal_id}, 'video_stage_change',
              ${JSON.stringify({ videoId, fromPhase: cur.production_phase, fromStage: cur.production_stage, toPhase: phase, toStage: stage })},
              ${user.email || null})
    `;
    await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${cur.deal_id}`;
  }
  const [row] = await VIDEO_SELECT(sql`WHERE pv.id = ${videoId}`);
  return res.status(200).json(serialiseVideo(row));
}

// Attach milestone approvals + per-milestone uploaded assets to a serialised
// video. Only used on the single-video paths (the board list stays lean).
async function withVideoExtras(video) {
  const [milestones, assets] = await Promise.all([
    sql`SELECT milestone, approved_at, approved_by FROM video_milestones WHERE video_id = ${video.id}`,
    sql`SELECT id, milestone, filename, mime_type, size_bytes, blob_url, web_view_link, uploaded_by, created_at
          FROM video_milestone_assets WHERE video_id = ${video.id} ORDER BY created_at DESC`,
  ]);
  video.milestones = milestones.map(m => ({ id: m.milestone, approvedAt: m.approved_at, approvedBy: m.approved_by }));

  const grouped = { script: [], storyboard: [], video: [] };
  for (const a of assets) {
    // Legacy 'visual_direction' assets now live under the combined Script & Text
    // Direction milestone ('script'). The data migration renames them, but map
    // here too so any straggler still surfaces.
    const key = a.milestone === 'visual_direction' ? 'script' : a.milestone;
    const item = {
      id: a.id, milestone: key, filename: a.filename, mimeType: a.mime_type || null,
      sizeBytes: a.size_bytes != null ? Number(a.size_bytes) : null,
      url: a.blob_url || a.web_view_link || null,
      driveUrl: a.web_view_link || null,
      uploadedBy: a.uploaded_by || null, createdAt: a.created_at,
    };
    if (grouped[key]) grouped[key].push(item); // already DESC → [0] is latest
  }
  video.milestoneAssets = grouped;
  const latestScript = grouped.script[0] || null;
  video.script = latestScript;

  // Stage-locked preview: the latest storyboard PDF (from the linked storyboard)
  // and the latest draft video (from the Video Revisions hand-off). Both guarded
  // so a missing/legacy table never breaks the video load.
  let storyboard = null, draftVideo = null;
  // Self-heal mirror of the revision auto-link, for the storyboard side: if a
  // producer created the storyboard project + storyboard through the
  // Storyboards admin (instead of clicking "Storyboard review" on the video
  // page), the project_video's storyboard_id is never set. Match by title via
  // a storyboard project linked to this deal (either link direction). Skipped
  // once the producer has explicitly linked/unlinked from the video page.
  if (!video.storyboardId && video.dealId && video.title) {
    try {
      await ensureLinkLockColumns();
      const [locked] = await sql`SELECT storyboard_link_locked_at FROM project_videos WHERE id = ${video.id}`;
      if (!locked?.storyboard_link_locked_at) {
        const [match] = await sql`
          SELECT sb.id
            FROM storyboards sb
            JOIN storyboard_projects sp ON sp.id = sb.project_id
            LEFT JOIN deals d ON d.id = ${video.dealId}
           WHERE (sp.deal_id = ${video.dealId} OR d.storyboard_project_id = sp.id)
             AND lower(btrim(sb.title)) = lower(btrim(${video.title}))
           LIMIT 1
        `;
        if (match?.id) {
          await sql`UPDATE project_videos SET storyboard_id = ${match.id}, updated_at = NOW() WHERE id = ${video.id}`;
          video.storyboardId = match.id;
        }
      }
    } catch { /* storyboard tables may not exist yet */ }
  }
  if (video.storyboardId) {
    try {
      const sv = (await sql`SELECT blob_url FROM storyboard_versions WHERE storyboard_id = ${video.storyboardId} ORDER BY version_number DESC LIMIT 1`)[0];
      if (sv?.blob_url) storyboard = { url: sv.blob_url };
    } catch { /* storyboard tables not present */ }
  }
  // Storyboard candidates on the same deal — drives the "Link to a storyboard"
  // picker when this video isn't linked yet.
  if (video.dealId) {
    try {
      video.dealStoryboards = await sql`
        SELECT sb.id, sb.title, sp.id AS project_id, sp.title AS project_title,
               (SELECT COUNT(*)::int FROM storyboard_versions WHERE storyboard_id = sb.id) AS version_count
          FROM storyboards sb
          JOIN storyboard_projects sp ON sp.id = sb.project_id
          LEFT JOIN deals d ON d.id = ${video.dealId}
         WHERE sp.deal_id = ${video.dealId} OR d.storyboard_project_id = sp.id
         ORDER BY sb.sort_order, sb.title
      `.then(rows => rows.map(r => ({
        id: r.id, title: r.title, projectId: r.project_id, projectTitle: r.project_title,
        versionCount: Number(r.version_count) || 0,
      })));
    } catch { video.dealStoryboards = []; }
  }
  // Self-heal: if a producer created the revision project + video through the
  // Revisions admin (instead of clicking "Send for review" on the video page),
  // this row's revision_video_id is never set and the video page shows nothing.
  // Look for a matching revision_video on a revision project linked to this deal
  // (either link direction) and back-fill it. Skipped once the producer has
  // explicitly linked or unlinked from the video page (revision_link_locked_at),
  // so a manual choice isn't silently overwritten on the next load.
  if (!video.revisionVideoId && video.dealId && video.title) {
    try {
      await ensureLinkLockColumns();
      const [locked] = await sql`SELECT revision_link_locked_at FROM project_videos WHERE id = ${video.id}`;
      if (!locked?.revision_link_locked_at) {
        const [match] = await sql`
          SELECT rv.id
            FROM revision_videos rv
            JOIN revision_projects rp ON rp.id = rv.project_id
            LEFT JOIN deals d ON d.id = ${video.dealId}
           WHERE (rp.deal_id = ${video.dealId} OR d.revision_project_id = rp.id)
             AND lower(btrim(rv.title)) = lower(btrim(${video.title}))
           LIMIT 1
        `;
        if (match?.id) {
          await sql`UPDATE project_videos SET revision_video_id = ${match.id}, updated_at = NOW() WHERE id = ${video.id}`;
          video.revisionVideoId = match.id;
        }
      }
    } catch { /* self-heal is best-effort */ }
  }
  // Surface every revision_video on a revision project linked to this deal,
  // so the video page can let the producer manually pick the right one when
  // the title-based auto-link above couldn't find a match. Cheap query; only
  // returns when at least one revision project is associated with the deal.
  if (video.dealId) {
    try {
      video.dealRevisionVideos = await sql`
        SELECT rv.id, rv.title, rp.id AS project_id, rp.title AS project_title,
               (SELECT COUNT(*)::int FROM revision_versions WHERE video_id = rv.id) AS version_count
          FROM revision_videos rv
          JOIN revision_projects rp ON rp.id = rv.project_id
          LEFT JOIN deals d ON d.id = ${video.dealId}
         WHERE rp.deal_id = ${video.dealId} OR d.revision_project_id = rp.id
         ORDER BY rv.sort_order, rv.title
      `.then(rows => rows.map(r => ({
        id: r.id, title: r.title, projectId: r.project_id, projectTitle: r.project_title,
        versionCount: Number(r.version_count) || 0,
      })));
    } catch { video.dealRevisionVideos = []; }
  }
  let revisionStatus = null;
  if (video.revisionVideoId) {
    try {
      const rv = (await sql`
        SELECT version_number, label, blob_url, mime_type, created_at
          FROM revision_versions
         WHERE video_id = ${video.revisionVideoId}
         ORDER BY version_number DESC
         LIMIT 1
      `)[0];
      if (rv?.blob_url) draftVideo = { url: rv.blob_url, mimeType: rv.mime_type || null };
      // Status block used by the video page to surface "Draft N · uploaded X"
      // and the review/approval/feedback state alongside the preview.
      const [{ version_count }] = await sql`
        SELECT COUNT(*)::int AS version_count FROM revision_versions WHERE video_id = ${video.revisionVideoId}
      `;
      const [vid] = await sql`
        SELECT approved_at, approved_by, feedback_submitted_at
          FROM revision_videos WHERE id = ${video.revisionVideoId}
      `;
      let commentCount = 0, openCommentCount = 0;
      if (rv?.version_number != null) {
        const [c] = await sql`
          SELECT COUNT(*)::int AS total,
                 COUNT(*) FILTER (WHERE completed_at IS NULL)::int AS open
            FROM revision_comments rc
            JOIN revision_versions rv2 ON rv2.id = rc.version_id
           WHERE rv2.video_id = ${video.revisionVideoId}
             AND rv2.version_number = ${rv.version_number}
        `;
        commentCount = c?.total || 0;
        openCommentCount = c?.open || 0;
      }
      revisionStatus = {
        versionCount: Number(version_count) || 0,
        latestVersionNumber: rv?.version_number != null ? Number(rv.version_number) : null,
        latestVersionLabel: rv?.label || null,
        latestVersionAt: rv?.created_at || null,
        approvedAt: vid?.approved_at || null,
        approvedBy: vid?.approved_by || null,
        feedbackSubmittedAt: vid?.feedback_submitted_at || null,
        commentCount,
        openCommentCount,
      };
    } catch { /* revision tables not present */ }
  }
  // Mirror of revisionStatus for the storyboard side: latest draft, approval,
  // feedback, comment counts. Drives the "Storyboard review" status card on
  // the video page.
  let storyboardStatus = null;
  if (video.storyboardId) {
    try {
      const sv = (await sql`
        SELECT version_number, label, blob_url, mime_type, created_at
          FROM storyboard_versions
         WHERE storyboard_id = ${video.storyboardId}
         ORDER BY version_number DESC
         LIMIT 1
      `)[0];
      const [{ version_count }] = await sql`
        SELECT COUNT(*)::int AS version_count FROM storyboard_versions WHERE storyboard_id = ${video.storyboardId}
      `;
      const [sb] = await sql`
        SELECT approved_at, approved_by, feedback_submitted_at
          FROM storyboards WHERE id = ${video.storyboardId}
      `;
      let commentCount = 0, openCommentCount = 0;
      if (sv?.version_number != null) {
        const [c] = await sql`
          SELECT COUNT(*)::int AS total,
                 COUNT(*) FILTER (WHERE completed_at IS NULL)::int AS open
            FROM storyboard_comments sc
            JOIN storyboard_versions sv2 ON sv2.id = sc.version_id
           WHERE sv2.storyboard_id = ${video.storyboardId}
             AND sv2.version_number = ${sv.version_number}
        `;
        commentCount = c?.total || 0;
        openCommentCount = c?.open || 0;
      }
      storyboardStatus = {
        versionCount: Number(version_count) || 0,
        latestVersionNumber: sv?.version_number != null ? Number(sv.version_number) : null,
        latestVersionLabel: sv?.label || null,
        latestVersionAt: sv?.created_at || null,
        approvedAt: sb?.approved_at || null,
        approvedBy: sb?.approved_by || null,
        feedbackSubmittedAt: sb?.feedback_submitted_at || null,
        commentCount,
        openCommentCount,
      };
    } catch { /* storyboard tables not present */ }
  }
  video.preview = {
    current: previewKindForStage(video.productionPhase, video.productionStage),
    script: video.script ? { url: video.script.url, filename: video.script.filename, mimeType: video.script.mimeType } : null,
    storyboard,
    video: draftVideo,
  };
  video.revisionStatus = revisionStatus;
  video.storyboardStatus = storyboardStatus;
  video.paymentOption = await paymentOptionForDeal(video.dealId);
  return video;
}

// Advance a video forward to (phase, stage) — only if that's strictly ahead of
// where it is now, so approving an earlier milestone late never regresses a
// card. Logs a video_stage_change event (same shape as moveVideo).
async function advanceVideoForward(videoId, phase, stage, user) {
  const cur = (await sql`SELECT deal_id, production_phase, production_stage FROM project_videos WHERE id = ${videoId}`)[0];
  if (!cur) return;
  if (stageOrderIndex(phase, stage) <= stageOrderIndex(cur.production_phase, cur.production_stage)) return;
  await sql`
    UPDATE project_videos
       SET production_phase = ${phase}, production_stage = ${stage}, production_stage_changed_at = NOW(), updated_at = NOW()
     WHERE id = ${videoId}
  `;
  await sql`
    INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
    VALUES (${cur.deal_id}, 'video_stage_change',
            ${JSON.stringify({ videoId, fromPhase: cur.production_phase, fromStage: cur.production_stage, toPhase: phase, toStage: stage })},
            ${user.email || null})
  `;
  await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${cur.deal_id}`;
}

// Approve / un-approve a milestone. Approving advances the card to the
// milestone's mapped stage (forward only).
async function setMilestone(req, res, videoId, user) {
  const { milestone, approved } = req.body || {};
  if (!isValidMilestone(milestone)) return res.status(400).json({ error: 'Invalid milestone' });
  const exists = (await sql`SELECT id FROM project_videos WHERE id = ${videoId}`)[0];
  if (!exists) return res.status(404).json({ error: 'Video not found' });

  if (approved) {
    await sql`
      INSERT INTO video_milestones (id, video_id, milestone, approved_by)
      VALUES (${makeId('vms')}, ${videoId}, ${milestone}, ${user.email || null})
      ON CONFLICT (video_id, milestone)
      DO UPDATE SET approved_at = NOW(), approved_by = EXCLUDED.approved_by
    `;
    const target = VIDEO_MILESTONE_BY_ID[milestone];
    if (target) await advanceVideoForward(videoId, target.phase, target.stage, user);
  } else {
    await sql`DELETE FROM video_milestones WHERE video_id = ${videoId} AND milestone = ${milestone}`;
  }
  const [row] = await VIDEO_SELECT(sql`WHERE pv.id = ${videoId}`);
  return res.status(200).json(await withVideoExtras(serialiseVideo(row)));
}

// Upload a script for a video. Drive when configured (into the deal's "Script
// and Text Direction" subfolder), else a private Blob. Re-uploading clears the
// 'script' milestone so producers re-review.
async function uploadScript(req, res, videoId, user) {
  const video = (await sql`SELECT id, deal_id FROM project_videos WHERE id = ${videoId}`)[0];
  if (!video) return res.status(404).json({ error: 'Video not found' });

  const useDrive = driveFilesEnabled();
  if (!useDrive && !process.env.BLOB_READ_WRITE_TOKEN)
    return res.status(503).json({ error: 'File storage not configured' });

  const filename = decodeURIComponent(req.headers['x-filename'] || 'script');
  const mimeType = req.headers['content-type'] || 'application/octet-stream';
  let fileBuffer = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : null;
  if (!fileBuffer) {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    fileBuffer = Buffer.concat(chunks);
  }
  if (!fileBuffer || fileBuffer.length === 0) return res.status(400).json({ error: 'No file data received' });
  if (fileBuffer.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'File too large (max 20 MB)' });

  const id = makeId('vscript');
  let driveFileId = null, webViewLink = null, blobUrl = null, blobPathname = null;

  if (useDrive) {
    let accessToken;
    try { accessToken = await getFreshAccessToken(user.email); }
    catch { return res.status(400).json({ error: 'Connect your Google account (with Drive access) to upload the script' }); }
    try {
      const root = await dealDriveFolder(accessToken, video.deal_id);
      const folderId = (await ensureSubfolderByPath(accessToken, root, SCRIPT_FOLDER_PATH)) || root;
      ({ id: driveFileId, webViewLink } = await uploadToFolder(accessToken, { folderId, filename, mimeType, buffer: fileBuffer }));
    } catch (err) {
      console.error('[script] drive upload failed', err.status, err.message);
      return res.status(502).json({ error: driveErrorHint(err) });
    }
  } else {
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = await put(`video-scripts/${videoId}/${id}/${safeName}`, fileBuffer, { access: 'private', contentType: mimeType });
    blobUrl = blob.url; blobPathname = blob.pathname;
  }

  await sql`
    INSERT INTO video_scripts
      (id, video_id, deal_id, filename, mime_type, size_bytes, drive_file_id, web_view_link, blob_url, blob_pathname, uploaded_by)
    VALUES
      (${id}, ${videoId}, ${video.deal_id}, ${filename}, ${mimeType}, ${fileBuffer.length},
       ${driveFileId}, ${webViewLink}, ${blobUrl}, ${blobPathname}, ${user.email || null})
  `;
  // A fresh script re-opens the Script milestone for review.
  await sql`DELETE FROM video_milestones WHERE video_id = ${videoId} AND milestone = 'script'`;

  const [row] = await VIDEO_SELECT(sql`WHERE pv.id = ${videoId}`);
  return res.status(201).json(await withVideoExtras(serialiseVideo(row)));
}

async function deleteScript(req, res, videoId, user) {
  const scriptId = req.query?.scriptId ? String(req.query.scriptId) : null;
  if (!scriptId) return res.status(400).json({ error: 'scriptId required' });
  const s = (await sql`SELECT id, drive_file_id, blob_url FROM video_scripts WHERE id = ${scriptId} AND video_id = ${videoId}`)[0];
  if (!s) return res.status(404).json({ error: 'Script not found' });
  if (s.drive_file_id && driveFilesEnabled()) {
    try { const at = await getFreshAccessToken(user.email); await deleteDriveFile(at, s.drive_file_id); }
    catch (err) { console.error('[script] drive delete failed', err.message); }
  }
  if (s.blob_url) { try { await del(s.blob_url); } catch (err) { console.error('[script] blob delete failed', err.message); } }
  await sql`DELETE FROM video_scripts WHERE id = ${scriptId}`;
  const [row] = await VIDEO_SELECT(sql`WHERE pv.id = ${videoId}`);
  return res.status(200).json(await withVideoExtras(serialiseVideo(row)));
}

// ── Per-milestone content uploads (Blob primary + best-effort Drive sync) ─────

// Mints a client-upload token against the public Revisions Blob store. The
// producer is already authenticated (productionRoute ran requireAuth +
// production.access before dispatching here).
async function milestoneAssetUploadToken(req, res) {
  if (!REVISION_BLOB_TOKEN) return res.status(503).json({ error: 'File storage not configured' });
  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      token: REVISION_BLOB_TOKEN,
      onBeforeGenerateToken: async () => ({ addRandomSuffix: true }),
      // No onUploadCompleted — the row is created by registerMilestoneAsset once
      // the browser upload resolves (matches the revisions uploader).
    });
    return res.status(200).json(jsonResponse);
  } catch (err) {
    if (res.headersSent) return;
    return res.status(400).json({ error: err?.message || 'Upload authorisation failed' });
  }
}

// Records a freshly-uploaded milestone asset, re-opens that milestone for
// review, and kicks off a best-effort Drive sync (after the response, via
// waitUntil, so the producer isn't kept waiting on the copy).
async function registerMilestoneAsset(req, res, videoId, user) {
  const milestone = req.query?.milestone ? String(req.query.milestone) : null;
  if (!isValidMilestone(milestone)) return res.status(400).json({ error: 'Invalid milestone' });
  const video = (await sql`SELECT id, deal_id FROM project_videos WHERE id = ${videoId}`)[0];
  if (!video) return res.status(404).json({ error: 'Video not found' });

  const body = req.body || {};
  // Two ways to register: a freshly-uploaded blob, or an external link (e.g. a
  // Google Doc script). A link stores the URL in blob_url with no pathname and
  // skips the Drive sync (there's no file to copy).
  const linkUrl = trimOrNull(body.linkUrl);
  const isLink = !!linkUrl;
  if (isLink && !/^https?:\/\//i.test(linkUrl)) {
    return res.status(400).json({ error: 'Enter a full URL starting with http:// or https://' });
  }
  const blobUrl = linkUrl || trimOrNull(body.blobUrl);
  if (!blobUrl) return res.status(400).json({ error: 'blobUrl or linkUrl required' });
  const blobPathname = isLink ? null : (body.blobPathname ? String(body.blobPathname) : null);
  const filename = trimOrNull(body.filename) || (isLink ? 'Linked document' : 'file');
  const mimeType = isLink ? 'link' : (body.mimeType ? String(body.mimeType) : null);
  const sizeBytes = isLink ? null : (Number.isFinite(Number(body.sizeBytes)) ? Number(body.sizeBytes) : null);

  const id = makeId('vma');
  await sql`
    INSERT INTO video_milestone_assets
      (id, video_id, milestone, filename, mime_type, size_bytes, blob_url, blob_pathname, uploaded_by)
    VALUES (${id}, ${videoId}, ${milestone}, ${filename}, ${mimeType}, ${sizeBytes}, ${blobUrl}, ${blobPathname}, ${user.email || null})
  `;
  // A fresh upload (or link) re-opens the milestone for review.
  await sql`DELETE FROM video_milestones WHERE video_id = ${videoId} AND milestone = ${milestone}`;

  // Best-effort Drive sync, buffered — skip links (no file) and very large files.
  if (!isLink && driveFilesEnabled() && (sizeBytes == null || sizeBytes <= 100 * 1024 * 1024)) {
    waitUntil(syncMilestoneAssetToDrive(id, video.deal_id, milestone, filename, mimeType, blobUrl, user.email)
      .catch((err) => console.error('[milestone] drive sync failed', err.message)));
  }

  const [row] = await VIDEO_SELECT(sql`WHERE pv.id = ${videoId}`);
  return res.status(201).json(await withVideoExtras(serialiseVideo(row)));
}

async function syncMilestoneAssetToDrive(assetId, dealId, milestone, filename, mimeType, blobUrl, userEmail) {
  const accessToken = await getFreshAccessToken(userEmail);
  const root = await dealDriveFolder(accessToken, dealId);
  // Images on the combined script milestone are reference imagery → file them
  // in the Reference Imagery folder rather than alongside the script doc.
  const isImage = (mimeType || '').startsWith('image/');
  const path = (milestone === 'script' && isImage)
    ? REFERENCE_IMAGERY_PATH
    : (MILESTONE_DRIVE_PATH[milestone] || []);
  const folderId = (await ensureSubfolderByPath(accessToken, root, path)) || root;
  const resp = await fetch(blobUrl);
  if (!resp.ok) throw new Error('blob fetch ' + resp.status);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const { id: driveId, webViewLink } = await uploadToFolder(accessToken, { folderId, filename, mimeType, buffer });
  await sql`UPDATE video_milestone_assets SET drive_file_id = ${driveId}, web_view_link = ${webViewLink} WHERE id = ${assetId}`;
}

async function deleteMilestoneAsset(req, res, videoId, user) {
  const assetId = req.query?.assetId ? String(req.query.assetId) : null;
  if (!assetId) return res.status(400).json({ error: 'assetId required' });
  const a = (await sql`SELECT id, blob_url, drive_file_id FROM video_milestone_assets WHERE id = ${assetId} AND video_id = ${videoId}`)[0];
  if (!a) return res.status(404).json({ error: 'Asset not found' });
  if (a.blob_url) { try { await del(a.blob_url, { token: REVISION_BLOB_TOKEN }); } catch (err) { console.error('[milestone] blob delete failed', err.message); } }
  if (a.drive_file_id && driveFilesEnabled()) {
    try { const at = await getFreshAccessToken(user.email); await deleteDriveFile(at, a.drive_file_id); }
    catch (err) { console.error('[milestone] drive delete failed', err.message); }
  }
  await sql`DELETE FROM video_milestone_assets WHERE id = ${assetId}`;
  const [row] = await VIDEO_SELECT(sql`WHERE pv.id = ${videoId}`);
  return res.status(200).json(await withVideoExtras(serialiseVideo(row)));
}

async function updateVideo(req, res, videoId) {
  const cur = (await sql`SELECT * FROM project_videos WHERE id = ${videoId}`)[0];
  if (!cur) return res.status(404).json({ error: 'Video not found' });
  const body = req.body || {};
  const title  = 'title'  in body ? (trimOrNull(body.title) || cur.title) : cur.title;
  const status = 'status' in body ? trimOrNull(body.status) : cur.status;
  if (!isValidVideoStatus(status)) return res.status(400).json({ error: 'Invalid status' });
  const paymentTerms          = 'paymentTerms'          in body ? trimOrNull(body.paymentTerms)          : cur.payment_terms;
  if (!isValidPaymentTerms(paymentTerms)) return res.status(400).json({ error: 'Invalid payment terms' });
  const videoLength           = 'videoLength'           in body ? trimOrNull(body.videoLength)           : cur.video_length;
  const deliveryDeadline      = 'deliveryDeadline'      in body ? trimOrNull(body.deliveryDeadline)      : cur.delivery_deadline;
  const textDirectionDeadline = 'textDirectionDeadline' in body ? trimOrNull(body.textDirectionDeadline) : cur.text_direction_deadline;
  // Producers: accept the array (producerEmails) or legacy single (producerEmail).
  // The producer_email column is kept as the first producer for back-compat.
  const producerKeyPresent = 'producerEmails' in body || 'producerEmail' in body;
  const nextProducers = producerKeyPresent ? readProducerEmails(body) : null;
  const producerEmail = producerKeyPresent ? (nextProducers[0] || null) : cur.producer_email;
  const sortRaw = 'sortOrder' in body ? numberOrNull(body.sortOrder) : null;
  const sortOrder = sortRaw == null ? cur.sort_order : Math.trunc(sortRaw);
  await sql`
    UPDATE project_videos
       SET title = ${title}, status = ${status}, payment_terms = ${paymentTerms},
           video_length = ${videoLength}, delivery_deadline = ${deliveryDeadline},
           text_direction_deadline = ${textDirectionDeadline}, producer_email = ${producerEmail},
           sort_order = ${sortOrder}, updated_at = NOW()
     WHERE id = ${videoId}
  `;
  if (producerKeyPresent) await setVideoAssignees(videoId, nextProducers);
  const [row] = await VIDEO_SELECT(sql`WHERE pv.id = ${videoId}`);
  return res.status(200).json(serialiseVideo(row));
}

// Normalise a producers payload to a deduped email array. Accepts the new
// `producerEmails` array or the legacy single `producerEmail`.
function readProducerEmails(body) {
  if (Array.isArray(body.producerEmails)) {
    return Array.from(new Set(body.producerEmails.map(trimOrNull).filter(Boolean)));
  }
  if ('producerEmail' in body) {
    const v = trimOrNull(body.producerEmail);
    return v ? [v] : [];
  }
  return [];
}

async function setVideoAssignees(videoId, emails) {
  await sql`DELETE FROM video_assignees WHERE video_id = ${videoId}`;
  if (emails.length) {
    await sql`INSERT INTO video_assignees (video_id, user_email) SELECT ${videoId}, unnest(${emails}::text[]) ON CONFLICT DO NOTHING`;
  }
}

// Hand a video off to the Revisions (client-review) section: create the deal's
// revision project on first use, add a revision video, link it, and return the
// public share link. Reuses the same row shapes as api/revisions/[action].js.
async function sendVideoForReview(res, videoId, user) {
  const video = (await sql`
    SELECT pv.id, pv.deal_id, pv.title, pv.revision_video_id,
           d.title AS deal_title, d.company_id, d.revision_project_id
      FROM project_videos pv
      JOIN deals d ON d.id = pv.deal_id
     WHERE pv.id = ${videoId}
  `)[0];
  if (!video) return res.status(404).json({ error: 'Video not found' });

  let revProjectId = video.revision_project_id;
  let shareToken = revProjectId
    ? (await sql`SELECT share_token FROM revision_projects WHERE id = ${revProjectId}`)[0]?.share_token || null
    : null;
  if (!revProjectId || !shareToken) {
    revProjectId = crypto.randomUUID();
    shareToken = crypto.randomUUID();
    const companyName = video.company_id
      ? (await sql`SELECT name FROM companies WHERE id = ${video.company_id}`)[0]?.name || null
      : null;
    await sql`
      INSERT INTO revision_projects (id, title, client_name, share_token, created_by)
      VALUES (${revProjectId}, ${video.deal_title}, ${companyName}, ${shareToken}, ${user.email || null})
    `;
    await sql`UPDATE deals SET revision_project_id = ${revProjectId} WHERE id = ${video.deal_id}`;
  }

  let revVideoId = video.revision_video_id;
  if (!revVideoId) {
    const [{ next }] = await sql`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM revision_videos WHERE project_id = ${revProjectId}`;
    revVideoId = crypto.randomUUID();
    await sql`
      INSERT INTO revision_videos (id, project_id, title, sort_order)
      VALUES (${revVideoId}, ${revProjectId}, ${video.title}, ${next})
    `;
    await sql`UPDATE project_videos SET revision_video_id = ${revVideoId}, updated_at = NOW() WHERE id = ${videoId}`;
  }
  await sql`UPDATE revision_projects SET updated_at = NOW() WHERE id = ${revProjectId}`;

  return res.status(200).json({
    ok: true,
    revisionProjectId: revProjectId,
    revisionVideoId: revVideoId,
    shareToken,
    reviewUrl: `${REVISION_PUBLIC_BASE}/?revision=${shareToken}`,
  });
}

// Manually link this project_video to an existing revision_video on the same
// deal's revision project. Used by the "Link revision" picker on the video
// page when the auto-match by title couldn't find a candidate (e.g. titles
// differ). Refuses cross-deal links to keep ownership clean.
async function linkRevisionVideo(req, res, videoId, user) {
  const { revisionVideoId } = req.body || {};
  if (!revisionVideoId) return res.status(400).json({ error: 'revisionVideoId required' });
  const [video] = await sql`SELECT id, deal_id FROM project_videos WHERE id = ${videoId}`;
  if (!video) return res.status(404).json({ error: 'Video not found' });
  const [rv] = await sql`
    SELECT rv.id, rp.deal_id AS rp_deal_id, d.revision_project_id
      FROM revision_videos rv
      JOIN revision_projects rp ON rp.id = rv.project_id
      LEFT JOIN deals d ON d.id = ${video.deal_id}
     WHERE rv.id = ${revisionVideoId}
       AND (rp.deal_id = ${video.deal_id} OR d.revision_project_id = rp.id)
     LIMIT 1
  `;
  if (!rv) return res.status(404).json({ error: 'Revision video not found on this deal' });
  await ensureLinkLockColumns();
  await sql`UPDATE project_videos
              SET revision_video_id = ${revisionVideoId},
                  revision_link_locked_at = NOW(),
                  updated_at = NOW()
            WHERE id = ${videoId}`;
  return res.status(200).json({ ok: true, revisionVideoId });
}

// Clear the project_video → revision_video link. Doesn't touch the revision
// project itself — the producer can re-link later, or this video can be hooked
// up to a different revision_video. Stamps revision_link_locked_at so the
// title-based auto-link in loadVideo doesn't silently put it back.
async function unlinkRevisionVideo(res, videoId) {
  await ensureLinkLockColumns();
  const [row] = await sql`
    UPDATE project_videos
       SET revision_video_id = NULL,
           revision_link_locked_at = NOW(),
           updated_at = NOW()
     WHERE id = ${videoId}
     RETURNING id
  `;
  if (!row) return res.status(404).json({ error: 'Video not found' });
  return res.status(200).json({ ok: true });
}

// Manually link this project_video to an existing storyboard on the same
// deal's storyboard project. Mirrors linkRevisionVideo.
async function linkStoryboard(req, res, videoId, user) {
  const { storyboardId } = req.body || {};
  if (!storyboardId) return res.status(400).json({ error: 'storyboardId required' });
  const [video] = await sql`SELECT id, deal_id FROM project_videos WHERE id = ${videoId}`;
  if (!video) return res.status(404).json({ error: 'Video not found' });
  const [sb] = await sql`
    SELECT sb.id, sp.deal_id AS sp_deal_id, d.storyboard_project_id
      FROM storyboards sb
      JOIN storyboard_projects sp ON sp.id = sb.project_id
      LEFT JOIN deals d ON d.id = ${video.deal_id}
     WHERE sb.id = ${storyboardId}
       AND (sp.deal_id = ${video.deal_id} OR d.storyboard_project_id = sp.id)
     LIMIT 1
  `;
  if (!sb) return res.status(404).json({ error: 'Storyboard not found on this deal' });
  await ensureLinkLockColumns();
  await sql`UPDATE project_videos
              SET storyboard_id = ${storyboardId},
                  storyboard_link_locked_at = NOW(),
                  updated_at = NOW()
            WHERE id = ${videoId}`;
  return res.status(200).json({ ok: true, storyboardId });
}

// Clear the project_video → storyboard link. Mirrors unlinkRevisionVideo.
async function unlinkStoryboard(res, videoId) {
  await ensureLinkLockColumns();
  const [row] = await sql`
    UPDATE project_videos
       SET storyboard_id = NULL,
           storyboard_link_locked_at = NOW(),
           updated_at = NOW()
     WHERE id = ${videoId}
     RETURNING id
  `;
  if (!row) return res.status(404).json({ error: 'Video not found' });
  return res.status(200).json({ ok: true });
}

// Hand a video off to the Storyboard Revisions section: lazily create the deal's
// storyboard project + a storyboard for this video, link them, and return the
// public share link. Mirrors sendVideoForReview; row shapes match
// api/storyboards/[action].js.
async function sendStoryboardForReview(res, videoId, user) {
  const video = (await sql`
    SELECT pv.id, pv.deal_id, pv.title, pv.storyboard_id,
           d.title AS deal_title, d.company_id, d.storyboard_project_id
      FROM project_videos pv
      JOIN deals d ON d.id = pv.deal_id
     WHERE pv.id = ${videoId}
  `)[0];
  if (!video) return res.status(404).json({ error: 'Video not found' });

  let projectId = video.storyboard_project_id;
  let shareToken = projectId
    ? (await sql`SELECT share_token FROM storyboard_projects WHERE id = ${projectId}`)[0]?.share_token || null
    : null;
  if (!projectId || !shareToken) {
    projectId = crypto.randomUUID();
    shareToken = crypto.randomUUID();
    const companyName = video.company_id
      ? (await sql`SELECT name FROM companies WHERE id = ${video.company_id}`)[0]?.name || null
      : null;
    await sql`
      INSERT INTO storyboard_projects (id, title, client_name, share_token, created_by)
      VALUES (${projectId}, ${video.deal_title}, ${companyName}, ${shareToken}, ${user.email || null})
    `;
    await sql`UPDATE deals SET storyboard_project_id = ${projectId} WHERE id = ${video.deal_id}`;
  }

  let storyboardId = video.storyboard_id;
  if (!storyboardId) {
    const [{ next }] = await sql`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM storyboards WHERE project_id = ${projectId}`;
    storyboardId = crypto.randomUUID();
    await sql`
      INSERT INTO storyboards (id, project_id, title, sort_order)
      VALUES (${storyboardId}, ${projectId}, ${video.title}, ${next})
    `;
    await sql`UPDATE project_videos SET storyboard_id = ${storyboardId}, updated_at = NOW() WHERE id = ${videoId}`;
  }
  await sql`UPDATE storyboard_projects SET updated_at = NOW() WHERE id = ${projectId}`;

  return res.status(200).json({
    ok: true,
    storyboardProjectId: projectId,
    storyboardId,
    shareToken,
    reviewUrl: `${REVISION_PUBLIC_BASE}/?storyboard=${shareToken}`,
  });
}

export function serialiseVideo(r) {
  const out = {
    id: r.id,
    dealId: r.deal_id,
    title: r.title,
    status: r.status,
    productionPhase: r.production_phase || null,
    productionStage: r.production_stage || null,
    productionStageChangedAt: r.production_stage_changed_at || null,
    paymentTerms: r.payment_terms || null,
    videoLength: r.video_length || null,
    deliveryDeadline: r.delivery_deadline || null,
    textDirectionDeadline: r.text_direction_deadline || null,
    producerEmail: r.producer_email || null,
    producerEmails: Array.isArray(r.producer_emails) && r.producer_emails.length
      ? r.producer_emails
      : (r.producer_email ? [r.producer_email] : []),
    sortOrder: r.sort_order,
    revisionVideoId: r.revision_video_id || null,
    storyboardId: r.storyboard_id || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at || null,
  };
  if ('project_title' in r) out.projectTitle = r.project_title || null;
  if ('company_name' in r) out.companyName = r.company_name || null;
  if ('drive_folder_id' in r) out.driveFolderId = r.drive_folder_id || null;
  if ('project_number' in r) out.projectNumber = r.project_number || null;
  if ('production_entered_at' in r) out.enteredProductionAt = r.production_entered_at || null;
  if ('production_start_date' in r) out.productionStartDate = r.production_start_date || null;
  if ('revision_round' in r) out.revisionRound = r.revision_round != null ? Number(r.revision_round) : null;
  return out;
}
