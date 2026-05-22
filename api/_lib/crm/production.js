// Production board API — moving paid deals (now "projects") through the
// production workflow, plus their videos and pre-paid credit balance. Routed
// from api/crm/[...slug].js as `case 'production'`.
//
//   POST   /api/crm/production/:dealId/move      { phase, stage }   — move on the board
//   POST   /api/crm/production/:dealId/enter                        — manual "Add to production"
//   POST   /api/crm/production/:dealId/credits   { delta }          — adjust credit balance
//   POST   /api/crm/production/:dealId/videos    { title?, fromCredit? } — add a video
//   PATCH  /api/crm/production/:dealId           { producerEmail?, paymentTerms?, deliveryDeadline?, textDirectionDeadline? }
//   PATCH  /api/crm/production/video/:videoId    { title?, status?, sortOrder? }
//   DELETE /api/crm/production/video/:videoId
//   POST   /api/crm/production/video/:videoId/send-for-review       — hand off to Revisions
import crypto from 'node:crypto';
import sql from '../db.js';
import { makeId, trimOrNull, numberOrNull } from './shared.js';
import { serialiseDeal } from './deals.js';
import { enterProduction } from '../production.js';
import { isValidStage } from '../dealStage.js';
import { isValidProductionStage, isValidVideoStatus, isValidPaymentTerms } from '../productionStages.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';

// Public base for client revision share links (matches RevisionsView.jsx).
const REVISION_PUBLIC_BASE = 'https://app.squideo.com';

export async function productionRoute(req, res, id, action, user, subaction = null) {
  if (!hasPermission(await getRole(user.role), 'production.access')) {
    return res.status(403).json({ error: 'You do not have permission to access production' });
  }

  // ── Create a project from scratch (and put it straight into production) ────
  // POST /api/crm/production  { title, companyId?, primaryContactId?, producerEmail?, ownerEmail?, value?, stage? }
  // The project IS a deal; a manually-created one defaults to the 'paid' sales
  // stage (committed work), changeable later via the deal's stage picker.
  if (!id) {
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

  // ── Video-scoped: /production/video/:videoId[/send-for-review] ─────────────
  if (id === 'video') {
    const videoId = action;
    if (!videoId) return res.status(400).json({ error: 'videoId required' });

    if (subaction === 'send-for-review') {
      if (req.method !== 'POST') return res.status(405).end();
      return sendVideoForReview(res, videoId, user);
    }
    if (req.method === 'PATCH') return updateVideo(req, res, videoId);
    if (req.method === 'DELETE') {
      const r = await sql`DELETE FROM project_videos WHERE id = ${videoId} RETURNING id`;
      if (!r.length) return res.status(404).json({ error: 'Video not found' });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  }

  // ── Project-scoped: /production/:dealId/... ───────────────────────────────
  const dealId = id;
  if (!dealId) return res.status(404).json({ error: 'Not found' });
  const deal = (await sql`SELECT id FROM deals WHERE id = ${dealId}`)[0];
  if (!deal) return res.status(404).json({ error: 'Deal not found' });

  // Move on the board (change phase/stage).
  if (action === 'move') {
    if (req.method !== 'POST') return res.status(405).end();
    const { phase, stage } = req.body || {};
    if (!isValidProductionStage(phase, stage)) return res.status(400).json({ error: 'Invalid phase/stage' });
    const cur = (await sql`SELECT production_phase, production_stage FROM deals WHERE id = ${dealId}`)[0];
    if (cur.production_phase === phase && cur.production_stage === stage) {
      const same = (await sql`SELECT * FROM deals WHERE id = ${dealId}`)[0];
      return res.status(200).json(serialiseDeal(same));
    }
    await sql`
      UPDATE deals
         SET production_phase = ${phase}, production_stage = ${stage},
             production_stage_changed_at = NOW(), last_activity_at = NOW(), updated_at = NOW()
       WHERE id = ${dealId}
    `;
    await sql`
      INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
      VALUES (${dealId}, 'production_stage_change',
              ${JSON.stringify({ fromPhase: cur.production_phase, fromStage: cur.production_stage, toPhase: phase, toStage: stage })},
              ${user.email || null})
    `;
    const row = (await sql`SELECT * FROM deals WHERE id = ${dealId}`)[0];
    return res.status(200).json(serialiseDeal(row));
  }

  // Manual "Add to production" for a paid deal that wasn't auto-added.
  if (action === 'enter') {
    if (req.method !== 'POST') return res.status(405).end();
    const result = await enterProduction(dealId, { source: 'manual', actorEmail: user.email });
    const row = (await sql`SELECT * FROM deals WHERE id = ${dealId}`)[0];
    return res.status(200).json({ ...serialiseDeal(row), entered: result.entered });
  }

  // Adjust the pre-paid credit balance (+N to add, -N to spend manually).
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

  // Add a video (optionally drawing one from the credit balance).
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
    const [row] = await sql`
      INSERT INTO project_videos (id, deal_id, title, status, sort_order, created_by)
      VALUES (${vid}, ${dealId}, ${title}, 'not_started', ${next}, ${user.email || null})
      RETURNING id, deal_id, title, status, sort_order, revision_video_id, created_at, updated_at
    `;
    return res.status(201).json(serialiseVideo(row));
  }

  // Update the project's production scheduling fields.
  if (!action && req.method === 'PATCH') {
    const body = req.body || {};
    const cur = (await sql`
      SELECT producer_email, payment_terms, delivery_deadline, text_direction_deadline, video_length
        FROM deals WHERE id = ${dealId}
    `)[0];
    const producerEmail          = 'producerEmail'          in body ? trimOrNull(body.producerEmail)          : cur.producer_email;
    const paymentTerms           = 'paymentTerms'           in body ? trimOrNull(body.paymentTerms)           : cur.payment_terms;
    const deliveryDeadline       = 'deliveryDeadline'       in body ? trimOrNull(body.deliveryDeadline)       : cur.delivery_deadline;
    const textDirectionDeadline  = 'textDirectionDeadline'  in body ? trimOrNull(body.textDirectionDeadline)  : cur.text_direction_deadline;
    const videoLength            = 'videoLength'            in body ? trimOrNull(body.videoLength)            : cur.video_length;
    if (!isValidPaymentTerms(paymentTerms)) return res.status(400).json({ error: 'Invalid payment terms' });
    await sql`
      UPDATE deals
         SET producer_email = ${producerEmail}, payment_terms = ${paymentTerms},
             delivery_deadline = ${deliveryDeadline}, text_direction_deadline = ${textDirectionDeadline},
             video_length = ${videoLength},
             updated_at = NOW()
       WHERE id = ${dealId}
    `;
    const row = (await sql`SELECT * FROM deals WHERE id = ${dealId}`)[0];
    return res.status(200).json(serialiseDeal(row));
  }

  return res.status(405).end();
}

async function updateVideo(req, res, videoId) {
  const cur = (await sql`SELECT * FROM project_videos WHERE id = ${videoId}`)[0];
  if (!cur) return res.status(404).json({ error: 'Video not found' });
  const body = req.body || {};
  const title  = 'title'  in body ? (trimOrNull(body.title) || cur.title) : cur.title;
  const status = 'status' in body ? trimOrNull(body.status) : cur.status;
  if (!isValidVideoStatus(status)) return res.status(400).json({ error: 'Invalid status' });
  const sortRaw = 'sortOrder' in body ? numberOrNull(body.sortOrder) : null;
  const sortOrder = sortRaw == null ? cur.sort_order : Math.trunc(sortRaw);
  await sql`
    UPDATE project_videos SET title = ${title}, status = ${status}, sort_order = ${sortOrder}, updated_at = NOW()
     WHERE id = ${videoId}
  `;
  return res.status(200).json(serialiseVideo({ ...cur, title, status, sort_order: sortOrder }));
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

  // Ensure a revision project exists for this deal.
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

  // Ensure a revision video exists and is linked back to this project video.
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
  return {
    id: r.id,
    dealId: r.deal_id,
    title: r.title,
    status: r.status,
    sortOrder: r.sort_order,
    revisionVideoId: r.revision_video_id || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at || null,
  };
}
