// Field allowlists for everything the portal API returns. Same doctrine as
// PUBLIC_PROPOSAL_FIELDS: clients only ever see explicitly enumerated fields —
// never deal value, owner emails, internal notes, Drive/Xero ids or anything
// about another organisation. No SELECT * passthrough to portal responses.

import { PHASE_BY_ID, VIDEO_STATUS_BY_ID, stageOrderIndex } from '../productionStages.js';

// Client-friendly pipeline labels; internal stages the portal never shows
// (lead/lost) are filtered out before serialisation.
const DEAL_STAGE_LABELS = {
  proposal_sent: 'Proposal sent',
  viewed: 'Proposal viewed',
  signed: 'Signed',
  paid: 'Paid',
};

// Client-facing wording for each internal production stage. The board uses
// operational names (Amends 1, Awaiting Feedback, On Hold, Back-up…) that we
// don't want to expose to clients; this maps every stage to a friendly label,
// collapsing internal holds (on_hold/back_up/reserved/days_off) to a neutral
// "In production". Keyed by stage id (ids are unique across phases). Any stage
// missing here falls back to its board label. Keep in step with
// api/_lib/productionStages.js PRODUCTION_PHASES.
const CLIENT_STAGE_LABELS = {
  // Pre-Production
  new_project: 'Getting started',
  script: 'Scriptwriting',
  script_amends: 'Script revisions',
  text_direction_pending: 'Scriptwriting',
  scripts_completed: 'Script ready',
  storyboard: 'Storyboard',
  amends_1: 'Storyboard revisions',
  awaiting_feedback_1: 'Awaiting your feedback',
  project_started: 'Ready for production',
  // Production
  in_production: 'In production',
  amends_2: 'Video revisions',
  awaiting_feedback_2: 'Awaiting your feedback',
  signed_off: 'Signed off',
  final_invoice: 'Awaiting final payment',
  back_up: 'In production',
  on_hold: 'In production',
  reserved: 'In production',
  reserved_express: 'In production',
  days_off_various: 'In production',
  // Completed
  delivered: 'Delivered',
  invoiced: 'Delivered',
  // After Care
  active: 'After care',
  closed: 'Completed',
};

export function stageInfo(phaseId, stageId) {
  const phase = PHASE_BY_ID[phaseId] || null;
  const stage = phase?.stages?.find((s) => s.id === stageId) || null;
  return {
    phase: phaseId || null,
    phaseLabel: phase?.label || null,
    phaseColor: phase?.color || null,
    // Client-friendly stage wording (falls back to the board label).
    stageLabel: (stageId && CLIENT_STAGE_LABELS[stageId]) || stage?.label || null,
  };
}

// A project's live position = its least-advanced video (matches the CRM's
// aggregateProjectPhase, but at stage granularity so the portal's sub-stage
// text tracks the real board). Returns { phase, stage } or null when no video
// has a board position yet. Rows are the raw project_videos records.
export function aggregateVideoStage(videos = []) {
  let best = null;
  let bestIdx = Infinity;
  for (const v of videos) {
    if (!v || !v.production_phase) continue;
    const idx = stageOrderIndex(v.production_phase, v.production_stage);
    if (idx < 0) continue;
    if (idx < bestIdx) { bestIdx = idx; best = { phase: v.production_phase, stage: v.production_stage }; }
  }
  return best;
}

export function serialisePortalDeal(deal, extras = {}) {
  // projectProduction is the { phase, stage } aggregated from the deal's videos
  // (the live board position). Prefer it over the deal's own stored columns,
  // which are stamped once at production start and never move. Destructured out
  // so it isn't leaked as its own field.
  const { projectProduction, ...rest } = extras;
  const prod = projectProduction || { phase: deal.production_phase, stage: deal.production_stage };
  return {
    id: deal.id,
    title: deal.title,
    companyId: deal.company_id,
    companyName: deal.company_name || null,
    stage: deal.stage,
    stageLabel: DEAL_STAGE_LABELS[deal.stage] || 'In progress',
    paymentTerms: deal.payment_terms || null,
    hasPoNumber: !!deal.po_number,
    production: stageInfo(prod.phase, prod.stage),
    inProduction: !!(prod.phase || deal.production_phase),
    createdAt: deal.created_at,
    deliveryDeadline: deal.delivery_deadline || null,
    ...rest,
  };
}

export function serialisePortalVideo(v) {
  const status = VIDEO_STATUS_BY_ID[v.status] || null;
  return {
    id: v.id,
    title: v.title,
    videoNumber: v.video_number ?? null,
    status: v.status || 'not_started',
    statusLabel: status?.label || 'Not started',
    statusColor: status?.color || '#94A3B8',
    videoLength: v.video_length || null,
    production: stageInfo(v.production_phase, v.production_stage),
    // The client's voiceover pick, made per video in the portal. Locked once
    // set (they can't change it). null until chosen.
    voiceover: v.voiceover_artist_id
      ? { artistId: v.voiceover_artist_id, artistName: v.voiceover_artist_name || 'Selected artist', category: v.voiceover_category || null, locked: true }
      : null,
  };
}

export function serialisePortalCompanyFile(f) {
  return {
    id: f.id,
    category: f.category || 'brand',
    filename: f.filename,
    mimeType: f.mime_type || null,
    sizeBytes: f.size_bytes == null ? null : Number(f.size_bytes),
    uploadedByPortalUser: f.uploaded_by_portal_user || null,
    uploadedByName: f.uploaded_by_name || null,
    createdAt: f.created_at,
  };
}

export function serialisePortalDealFile(f) {
  return {
    id: f.id,
    filename: f.filename,
    mimeType: f.mime_type || null,
    sizeBytes: f.size_bytes == null ? null : Number(f.size_bytes),
    uploadedByPortalUser: f.portal_user_id || null,
    createdAt: f.created_at,
  };
}

export function serialisePortalExtra(r) {
  return {
    id: r.id,
    description: r.description,
    amount: r.amount == null ? null : Number(r.amount),
    status: r.status,
    createdAt: r.created_at,
  };
}

export function serialisePortalMember(m) {
  return {
    id: m.id,
    email: m.email,
    name: m.name || null,
    jobTitle: m.job_title || null,
    lastLoginAt: m.last_login_at || null,
    joinedAt: m.member_since || m.created_at,
    disabled: !!m.disabled_at || !!m.membership_disabled_at,
  };
}

export function serialisePortalInvite(i) {
  return {
    id: i.id,
    email: i.email,
    invitedBy: i.invited_by || null,
    expiresAt: i.expires_at,
    createdAt: i.created_at,
  };
}
