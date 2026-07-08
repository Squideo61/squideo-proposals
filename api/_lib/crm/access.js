// Freelancer access scoping. Freelancers are external contractors who may only
// see the projects they've been assigned to work on. The producer/freelancer
// shell in the SPA is cosmetic — these helpers enforce the real scope on the
// server. The single primitive everywhere is "is this user assigned to this
// deal/video?": a video producer (video_assignees), the deal's producer
// (deals.producer_email), or a deal-team member (deal_assignees).

import sql from '../db.js';

// Only the freelancer role gets the tightened, assignment-only scope. Producers
// and copywriters keep their existing full-board visibility.
export function isFreelancer(role) {
  return role?.id === 'freelancer';
}

// Distinct deal ids the user is assigned to (video producer, deal producer, or
// deal-team member). Used to scope list views.
export async function freelancerDealIds(email) {
  const e = String(email || '').toLowerCase();
  if (!e) return [];
  const rows = await sql`
    SELECT DISTINCT d.id
      FROM deals d
     WHERE LOWER(d.producer_email) = ${e}
        OR EXISTS (SELECT 1 FROM deal_assignees da WHERE da.deal_id = d.id AND LOWER(da.user_email) = ${e})
        OR EXISTS (SELECT 1 FROM project_videos pv
                     JOIN video_assignees va ON va.video_id = pv.id
                    WHERE pv.deal_id = d.id AND LOWER(va.user_email) = ${e})`;
  return rows.map(r => r.id);
}

// True if the user is assigned to this deal (any of its videos, or the deal).
export async function userOnDeal(email, dealId) {
  const e = String(email || '').toLowerCase();
  if (!e || !dealId) return false;
  const [row] = await sql`
    SELECT 1 AS ok FROM deals d
     WHERE d.id = ${dealId}
       AND ( LOWER(d.producer_email) = ${e}
          OR EXISTS (SELECT 1 FROM deal_assignees da WHERE da.deal_id = d.id AND LOWER(da.user_email) = ${e})
          OR EXISTS (SELECT 1 FROM project_videos pv JOIN video_assignees va ON va.video_id = pv.id
                       WHERE pv.deal_id = d.id AND LOWER(va.user_email) = ${e}) )
     LIMIT 1`;
  return !!row;
}

// Reusable "is the freelancer on the deal linked to this row" condition, given
// a deal_id column reference. Kept as a plain string builder is avoided — we
// inline the same EXISTS in each helper to keep the parameterisation safe.

// Revision-project ids a freelancer may see: directly assigned, linked to a deal
// they're on, or linked to a board video they produce (project_videos.revision_video_id).
export async function freelancerRevisionProjectIds(email) {
  const e = String(email || '').toLowerCase();
  if (!e) return [];
  const rows = await sql`
    SELECT rp.id FROM revision_projects rp
     WHERE LOWER(rp.assignee_email) = ${e}
        OR EXISTS (SELECT 1 FROM deals d WHERE d.id = rp.deal_id AND (
             LOWER(d.producer_email) = ${e}
             OR EXISTS (SELECT 1 FROM deal_assignees da WHERE da.deal_id = d.id AND LOWER(da.user_email) = ${e})
             OR EXISTS (SELECT 1 FROM project_videos pv JOIN video_assignees va ON va.video_id = pv.id
                          WHERE pv.deal_id = d.id AND LOWER(va.user_email) = ${e}) ))
        OR EXISTS (SELECT 1 FROM project_videos pv JOIN video_assignees va ON va.video_id = pv.id
                     WHERE pv.revision_video_id IN (SELECT id FROM revision_videos WHERE project_id = rp.id)
                       AND LOWER(va.user_email) = ${e})`;
  return rows.map(r => r.id);
}

// Storyboard-project ids a freelancer may see (structural parallel of the above;
// board link is project_videos.storyboard_id → storyboards → storyboard_projects).
export async function freelancerStoryboardProjectIds(email) {
  const e = String(email || '').toLowerCase();
  if (!e) return [];
  const rows = await sql`
    SELECT sp.id FROM storyboard_projects sp
     WHERE LOWER(sp.assignee_email) = ${e}
        OR EXISTS (SELECT 1 FROM deals d WHERE d.id = sp.deal_id AND (
             LOWER(d.producer_email) = ${e}
             OR EXISTS (SELECT 1 FROM deal_assignees da WHERE da.deal_id = d.id AND LOWER(da.user_email) = ${e})
             OR EXISTS (SELECT 1 FROM project_videos pv JOIN video_assignees va ON va.video_id = pv.id
                          WHERE pv.deal_id = d.id AND LOWER(va.user_email) = ${e}) ))
        OR EXISTS (SELECT 1 FROM project_videos pv JOIN video_assignees va ON va.video_id = pv.id
                     WHERE pv.storyboard_id IN (SELECT id FROM storyboards WHERE project_id = sp.id)
                       AND LOWER(va.user_email) = ${e})`;
  return rows.map(r => r.id);
}

// True if the user is assigned to this specific video (or its parent deal).
export async function userOnVideo(email, videoId) {
  const e = String(email || '').toLowerCase();
  if (!e || !videoId) return false;
  const [row] = await sql`
    SELECT 1 AS ok FROM project_videos pv
     WHERE pv.id = ${videoId}
       AND ( LOWER(pv.producer_email) = ${e}
          OR EXISTS (SELECT 1 FROM video_assignees va WHERE va.video_id = pv.id AND LOWER(va.user_email) = ${e})
          OR EXISTS (SELECT 1 FROM deals d WHERE d.id = pv.deal_id
                       AND ( LOWER(d.producer_email) = ${e}
                          OR EXISTS (SELECT 1 FROM deal_assignees da WHERE da.deal_id = d.id AND LOWER(da.user_email) = ${e}) )) )
     LIMIT 1`;
  return !!row;
}
