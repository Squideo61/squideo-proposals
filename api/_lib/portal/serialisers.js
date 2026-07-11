// Field allowlists for everything the portal API returns. Same doctrine as
// PUBLIC_PROPOSAL_FIELDS: clients only ever see explicitly enumerated fields —
// never deal value, owner emails, internal notes, Drive/Xero ids or anything
// about another organisation. No SELECT * passthrough to portal responses.

import { PHASE_BY_ID, VIDEO_STATUS_BY_ID } from '../productionStages.js';

// Client-friendly pipeline labels; internal stages the portal never shows
// (lead/lost) are filtered out before serialisation.
const DEAL_STAGE_LABELS = {
  proposal_sent: 'Proposal sent',
  viewed: 'Proposal viewed',
  signed: 'Signed',
  paid: 'Paid',
};

export function stageInfo(phaseId, stageId) {
  const phase = PHASE_BY_ID[phaseId] || null;
  const stage = phase?.stages?.find((s) => s.id === stageId) || null;
  return {
    phase: phaseId || null,
    phaseLabel: phase?.label || null,
    phaseColor: phase?.color || null,
    stageLabel: stage?.label || null,
  };
}

export function serialisePortalDeal(deal, extras = {}) {
  return {
    id: deal.id,
    title: deal.title,
    companyId: deal.company_id,
    companyName: deal.company_name || null,
    stage: deal.stage,
    stageLabel: DEAL_STAGE_LABELS[deal.stage] || 'In progress',
    paymentTerms: deal.payment_terms || null,
    hasPoNumber: !!deal.po_number,
    production: stageInfo(deal.production_phase, deal.production_stage),
    inProduction: !!deal.production_phase,
    createdAt: deal.created_at,
    deliveryDeadline: deal.delivery_deadline || null,
    ...extras,
  };
}

export function serialisePortalVideo(v) {
  const status = VIDEO_STATUS_BY_ID[v.status] || null;
  return {
    id: v.id,
    title: v.title,
    status: v.status || 'not_started',
    statusLabel: status?.label || 'Not started',
    statusColor: status?.color || '#94A3B8',
    videoLength: v.video_length || null,
    production: stageInfo(v.production_phase, v.production_stage),
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
