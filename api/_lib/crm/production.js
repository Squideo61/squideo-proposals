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
import sql from '../db.js';
import { makeId, trimOrNull, numberOrNull } from './shared.js';
import { serialiseDeal, ensureDealFileDriveColumns } from './deals.js';
import { enterProduction, ensureProductionSchema, backfillPaidDealsIntoProduction } from '../production.js';
import { isValidStage } from '../dealStage.js';
import { isValidProductionStage, isValidVideoStatus, isValidPaymentTerms, FIRST_PRODUCTION } from '../productionStages.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';

// Public base for client revision share links (matches RevisionsView.jsx).
const REVISION_PUBLIC_BASE = 'https://app.squideo.com';

// Board / single-video query: a video joined to its project (deal) + customer.
const VIDEO_SELECT = (whereSql) => sql`
  SELECT pv.*, d.title AS project_title, c.name AS company_name,
         d.drive_folder_id AS drive_folder_id,
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
        SELECT pv.*, d.title AS project_title, c.name AS company_name
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
    if (subaction === 'move') {
      if (req.method !== 'POST') return res.status(405).end();
      return moveVideo(req, res, videoId, user);
    }
    if (req.method === 'GET') {
      const [row] = await VIDEO_SELECT(sql`WHERE pv.id = ${videoId}`);
      if (!row) return res.status(404).json({ error: 'Video not found' });
      return res.status(200).json(serialiseVideo(row));
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
  const producerEmail         = 'producerEmail'         in body ? trimOrNull(body.producerEmail)         : cur.producer_email;
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
  const [row] = await VIDEO_SELECT(sql`WHERE pv.id = ${videoId}`);
  return res.status(200).json(serialiseVideo(row));
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
    sortOrder: r.sort_order,
    revisionVideoId: r.revision_video_id || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at || null,
  };
  if ('project_title' in r) out.projectTitle = r.project_title || null;
  if ('company_name' in r) out.companyName = r.company_name || null;
  if ('drive_folder_id' in r) out.driveFolderId = r.drive_folder_id || null;
  if ('project_number' in r) out.projectNumber = r.project_number || null;
  return out;
}
