// "Submit to client for review" — the single gate that makes an uploaded
// storyboard/video draft visible to the client and notifies them.
//
// Uploading a draft (api/revisions|storyboards/[action].js registerVersion) is
// now purely internal. Only this helper bumps client_submitted_version — the
// highest version_number the client is allowed to see in the portal + share
// link viewer — clears any prior approval/feedback so the review reopens, and
// fires the client-facing portal notification. Shared by the revision/storyboard
// routers (staff, by revision_video_id/storyboard_id) and the CRM production
// router (by project_videos id) so there is one source of truth.

import sql from '../db.js';
import { notifyPortalUser } from '../portal/notifications.js';

async function logDealEvent(dealId, eventType, payload, actorEmail) {
  if (!dealId) return;
  try {
    await sql`
      INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
      VALUES (${dealId}, ${eventType}, ${JSON.stringify(payload || {})}, ${actorEmail || null})`;
  } catch (err) {
    console.warn('[clientReview] deal event log failed', err.message);
  }
}

// Submit the latest uploaded video draft to the client. Returns
// { clientSubmittedVersion, clientSubmittedAt, shareToken } or { error }.
export async function submitRevisionToClient({ revisionVideoId, actorEmail }) {
  const [row] = await sql`
    SELECT rv.title, rv.project_id, rp.deal_id, rp.share_token, d.company_id,
           (SELECT MAX(version_number) FROM revision_versions WHERE video_id = rv.id) AS max_ver
      FROM revision_videos rv
      JOIN revision_projects rp ON rp.id = rv.project_id
      LEFT JOIN deals d ON d.id = rp.deal_id
     WHERE rv.id = ${revisionVideoId}`;
  if (!row) return { error: 'not-found' };
  if (row.max_ver == null) return { error: 'no-draft' };

  const submittedAt = new Date();
  await sql`
    UPDATE revision_videos
       SET client_submitted_version = ${row.max_ver},
           client_submitted_at = NOW(),
           client_submitted_by = ${actorEmail || null},
           approved_at = NULL, approved_by = NULL, feedback_submitted_at = NULL
     WHERE id = ${revisionVideoId}`;
  await sql`UPDATE revision_projects SET updated_at = NOW() WHERE id = ${row.project_id}`;

  await notifyPortalUser({
    companyId: row.company_id,
    dealId: row.deal_id,
    key: 'portal.revision_ready',
    title: 'Your video is ready to review',
    body: `A new version of "${row.title}" is ready for your feedback.`,
    link: `#/review/${row.share_token}`,
  });
  await logDealEvent(row.deal_id, 'revision_submitted_to_client',
    { video: row.title, version: row.max_ver }, actorEmail);

  return { clientSubmittedVersion: row.max_ver, clientSubmittedAt: submittedAt.toISOString(), shareToken: row.share_token };
}

// Submit the latest uploaded storyboard PDF draft to the client.
export async function submitStoryboardToClient({ storyboardId, actorEmail }) {
  const [row] = await sql`
    SELECT sb.title, sb.project_id, sp.deal_id, sp.share_token, d.company_id,
           (SELECT MAX(version_number) FROM storyboard_versions WHERE storyboard_id = sb.id) AS max_ver
      FROM storyboards sb
      JOIN storyboard_projects sp ON sp.id = sb.project_id
      LEFT JOIN deals d ON d.id = sp.deal_id
     WHERE sb.id = ${storyboardId}`;
  if (!row) return { error: 'not-found' };
  if (row.max_ver == null) return { error: 'no-draft' };

  const submittedAt = new Date();
  await sql`
    UPDATE storyboards
       SET client_submitted_version = ${row.max_ver},
           client_submitted_at = NOW(),
           client_submitted_by = ${actorEmail || null},
           approved_at = NULL, approved_by = NULL, feedback_submitted_at = NULL
     WHERE id = ${storyboardId}`;
  await sql`UPDATE storyboard_projects SET updated_at = NOW() WHERE id = ${row.project_id}`;

  await notifyPortalUser({
    companyId: row.company_id,
    dealId: row.deal_id,
    key: 'portal.storyboard_ready',
    title: 'Your storyboard is ready to review',
    body: `A new version of "${row.title}" is ready for your feedback.`,
    link: `#/storyboard/${row.share_token}`,
  });
  await logDealEvent(row.deal_id, 'storyboard_submitted_to_client',
    { storyboard: row.title, version: row.max_ver }, actorEmail);

  return { clientSubmittedVersion: row.max_ver, clientSubmittedAt: submittedAt.toISOString(), shareToken: row.share_token };
}
