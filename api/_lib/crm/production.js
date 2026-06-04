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
import sql from '../db.js';
import { makeId, trimOrNull, numberOrNull, driveFilesEnabled } from './shared.js';
import { serialiseDeal, ensureDealFileDriveColumns, dealDriveFolder, driveErrorHint } from './deals.js';
import { getFreshAccessToken } from './gmail.js';
import { uploadToFolder, ensureSubfolderByPath, deleteDriveFile } from '../googleDrive.js';
import { enterProduction, ensureProductionSchema, backfillPaidDealsIntoProduction } from '../production.js';
import { isValidStage } from '../dealStage.js';
import { isValidProductionStage, isValidVideoStatus, isValidPaymentTerms, isValidMilestone, VIDEO_MILESTONE_BY_ID, stageOrderIndex, previewKindForStage, FIRST_PRODUCTION } from '../productionStages.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';

// Where scripts live inside a deal's Drive folder (from the FOLDER_TEMPLATE in
// googleDrive.js).
const SCRIPT_FOLDER_PATH = ['2. Pre-Production', '1. Script and Text Direction'];

// Public base for client revision share links (matches RevisionsView.jsx).
const REVISION_PUBLIC_BASE = 'https://app.squideo.com';

// Board / single-video query: a video joined to its project (deal) + customer.
const VIDEO_SELECT = (whereSql) => sql`
  SELECT pv.*, d.title AS project_title, c.name AS company_name,
         d.drive_folder_id AS drive_folder_id,
         (SELECT COALESCE(ARRAY_AGG(va.user_email ORDER BY va.assigned_at), '{}')
            FROM video_assignees va WHERE va.video_id = pv.id) AS producer_emails,
         (SELECT p.number_year || '-' || lpad(p.number_seq::text, 3, '0')
            FROM proposals p
           WHERE p.deal_id = d.id AND p.number_seq IS NOT NULL
           ORDER BY p.number_seq ASC LIMIT 1) AS project_number
    FROM project_videos pv
    JOIN deals d ON d.id = pv.deal_id
    LEFT JOIN companies c ON c.id = d.company_id
   ${whereSql}
`;

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
      // Self-heal: pull any already-paid deal onto the board before listing, so a
      // deal paid via a route that didn't auto-enter still shows up here.
      await backfillPaidDealsIntoProduction();
      const rows = await sql`
        SELECT pv.*, d.title AS project_title, c.name AS company_name,
               (SELECT COALESCE(ARRAY_AGG(va.user_email ORDER BY va.assigned_at), '{}')
                  FROM video_assignees va WHERE va.video_id = pv.id) AS producer_emails
          FROM project_videos pv
          JOIN deals d ON d.id = pv.deal_id
          LEFT JOIN companies c ON c.id = d.company_id
         WHERE pv.production_phase IS NOT NULL
         ORDER BY pv.sort_order, pv.created_at
      `;
      return res.status(200).json(rows.map(serialiseVideo));
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
    if (req.method === 'GET') {
      const [row] = await VIDEO_SELECT(sql`WHERE pv.id = ${videoId}`);
      if (!row) return res.status(404).json({ error: 'Video not found' });
      return res.status(200).json(await withVideoExtras(serialiseVideo(row)));
    }
    if (req.method === 'PATCH') return updateVideo(req, res, videoId);
    if (req.method === 'DELETE') {
      const r = await sql`DELETE FROM project_videos WHERE id = ${videoId} RETURNING id`;
      if (!r.length) return res.status(404).json({ error: 'Video not found' });
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

// Attach milestone approvals + the current script to a serialised video. Only
// used on the single-video paths (the board list stays lean).
async function withVideoExtras(video) {
  const [milestones, scripts] = await Promise.all([
    sql`SELECT milestone, approved_at, approved_by FROM video_milestones WHERE video_id = ${video.id}`,
    sql`SELECT id, filename, mime_type, size_bytes, web_view_link, blob_url, uploaded_by, created_at
          FROM video_scripts WHERE video_id = ${video.id} ORDER BY created_at DESC LIMIT 1`,
  ]);
  video.milestones = milestones.map(m => ({ id: m.milestone, approvedAt: m.approved_at, approvedBy: m.approved_by }));
  const s = scripts[0];
  let url = s?.web_view_link || null;
  if (s && !url && s.blob_url) { try { url = await getDownloadUrl(s.blob_url); } catch { url = null; } }
  video.script = s ? {
    id: s.id, filename: s.filename, mimeType: s.mime_type || null,
    sizeBytes: s.size_bytes != null ? Number(s.size_bytes) : null,
    url,
    uploadedBy: s.uploaded_by || null, createdAt: s.created_at,
  } : null;

  // Stage-locked preview: the latest storyboard PDF (from the linked storyboard)
  // and the latest draft video (from the Video Revisions hand-off). Both guarded
  // so a missing/legacy table never breaks the video load.
  let storyboard = null, draftVideo = null;
  if (video.storyboardId) {
    try {
      const sv = (await sql`SELECT blob_url FROM storyboard_versions WHERE storyboard_id = ${video.storyboardId} ORDER BY version_number DESC LIMIT 1`)[0];
      if (sv?.blob_url) storyboard = { url: sv.blob_url };
    } catch { /* storyboard tables not present */ }
  }
  if (video.revisionVideoId) {
    try {
      const rv = (await sql`SELECT blob_url, mime_type FROM revision_versions WHERE video_id = ${video.revisionVideoId} ORDER BY version_number DESC LIMIT 1`)[0];
      if (rv?.blob_url) draftVideo = { url: rv.blob_url, mimeType: rv.mime_type || null };
    } catch { /* revision tables not present */ }
  }
  video.preview = {
    current: previewKindForStage(video.productionPhase, video.productionStage),
    script: video.script ? { url: video.script.url, filename: video.script.filename, mimeType: video.script.mimeType } : null,
    storyboard,
    video: draftVideo,
  };
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
  return out;
}
