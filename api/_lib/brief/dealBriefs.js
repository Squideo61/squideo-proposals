// A deal's client briefs, resolved against the videos they're for.
//
// Shared by the deal page's Client portal card (api/crm/portal-admin.js) and the
// video page (api/_lib/crm/production.js), because the two must agree about
// which video a brief belongs to. A brief that reads "Video 1" on the deal and
// then fails to appear on Video 1 is worse than not showing it at all.
//
// WHY A BRIEF NAMES A VIDEO. A deal can carry several videos, and a client who
// briefs "the onboarding one" is briefing one of them. Until now a brief only
// named the deal, so on a three-video project the team had to guess. The column
// is nullable and most briefs will never set it — hence the default below.

import sql from '../db.js';
import { ensureClientBriefs } from './db.js';
import { briefProgress, renderBriefText } from './questions.js';
import { loadBriefActivity } from './collab.js';

// A deal's videos in the order the CRM shows them, plus which one an unassigned
// brief belongs to.
//
// The default is the FIRST video, not "none". A single-video project — which is
// most of them — should never make anyone pick, and on a multi-video project
// the first is where a brief written before the others existed actually belongs.
// It's a default, not a decision: staff can reassign it, and doing so writes the
// column so it stops being a guess.
export async function dealBriefVideos(dealId) {
  const rows = await sql`
    SELECT id, title, video_number
      FROM project_videos
     WHERE deal_id = ${dealId}
     ORDER BY sort_order ASC, created_at ASC
  `.catch(() => []);
  const videos = rows.map((v, i) => ({
    id: v.id,
    title: v.title || `Video ${v.video_number ?? i + 1}`,
    videoNumber: v.video_number ?? i + 1,
  }));
  return { videos, defaultVideoId: videos[0]?.id || null };
}

// How far through, in words rather than a fraction. "22/25" is precise and
// unreadable at a glance; what the team actually needs off a collapsed row is
// whether this brief is finished enough to work from.
export function briefStatus(b, progress) {
  if (b.submitted_at) return 'completed';
  if (progress.pct >= 100) return 'answered';   // done, but not sent to us yet
  if (progress.pct > 0) return 'part';
  return 'empty';
}

// Serialise the briefs filed against a deal. `withActivity` is off by default
// because the video page shows one brief inline and doesn't need who-changed-
// what; the deal card asks for it.
export async function briefsForDeal(dealId, { withActivity = false } = {}) {
  await ensureClientBriefs();
  const [rows, { videos, defaultVideoId }] = await Promise.all([
    sql`
      SELECT b.id, b.title, b.answers, b.completed_at, b.submitted_at, b.updated_at,
             b.contributor_count, b.reopened_at, b.video_id,
             pu.name AS submitted_by_name, pu.email AS submitted_by_email
        FROM client_briefs b
        LEFT JOIN portal_users pu ON pu.id = b.submitted_by
       WHERE b.deal_id = ${dealId}
       ORDER BY (b.submitted_at IS NULL) DESC, b.updated_at DESC
    `.catch(() => []),
    dealBriefVideos(dealId),
  ]);

  const byId = new Map(videos.map((v) => [v.id, v]));
  const briefs = await Promise.all(rows.map(async (b) => {
    const progress = briefProgress(b.answers || {});
    // An explicit video_id that no longer exists (video deleted) falls back to
    // the default rather than showing a brief attached to nothing.
    const videoId = (b.video_id && byId.has(b.video_id)) ? b.video_id : defaultVideoId;
    return {
      id: b.id,
      title: b.title || (b.answers || {}).projectName || 'Video brief',
      locked: !!b.submitted_at,
      submittedAt: b.submitted_at || null,
      submittedBy: b.submitted_by_name || b.submitted_by_email || null,
      reopenedAt: b.reopened_at || null,
      updatedAt: b.updated_at || null,
      contributors: Math.max(1, Number(b.contributor_count) || 1),
      status: briefStatus(b, progress),
      videoId,
      videoTitle: byId.get(videoId)?.title || null,
      // True when nobody has said which video this is for, so the UI can show
      // the default as an assumption rather than as a fact.
      videoAssumed: !b.video_id || !byId.has(b.video_id),
      // Rendered server-side by the same function that writes the quote
      // request, so what the team reads here is what they would have read
      // in the enquiry — one document, one rendering.
      text: renderBriefText(b.answers || {}),
      activity: withActivity ? await loadBriefActivity(b.id, 12) : [],
      ...progress,
    };
  }));
  return { briefs, videos };
}

// Point a brief at one of its deal's videos, or back to no explicit choice.
// Returns false when the brief doesn't exist or the video isn't on its deal —
// the route 404s rather than silently filing a brief against another project.
export async function setBriefVideo(briefId, videoId) {
  await ensureClientBriefs();
  const [brief] = await sql`SELECT id, deal_id FROM client_briefs WHERE id = ${briefId}`
    .catch(() => []);
  if (!brief) return false;
  if (videoId) {
    const [v] = await sql`
      SELECT id FROM project_videos WHERE id = ${videoId} AND deal_id = ${brief.deal_id}
    `.catch(() => []);
    if (!v) return false;
  }
  await sql`
    UPDATE client_briefs SET video_id = ${videoId || null}, updated_at = updated_at
     WHERE id = ${briefId}
  `.catch(() => {});
  return true;
}
