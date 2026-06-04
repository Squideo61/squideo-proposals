// Canonical production-workflow definitions for the project-management board
// (the Monday.com replacement). A project = a paid deal; it lives in one
// `phase` (board tab) and one `stage` (kanban column within that tab).
//
// This file is the source of truth for the WEB APP. An identical copy lives at
// api/_lib/productionStages.js for server-side validation (build isolation —
// the API can't import from src/). Keep the two in lockstep: change here, then
// copy across.
//
// Stages are intentionally data-driven so they're trivial to rename/reorder.
// Pre-Production is taken from the live Monday board; Production / Completed /
// After Care are sensible starting points — adjust to match the real groups.

export const PRODUCTION_PHASES = [
  {
    id: 'pre_production', label: 'Pre-Production', color: '#7C3AED',
    stages: [
      { id: 'new_project',       label: 'New Project' },
      { id: 'script',            label: 'Script' },
      { id: 'scripts_completed', label: 'Scripts Completed' },
      { id: 'storyboard',        label: 'Storyboard' },
      { id: 'amends_1',          label: 'Amends 1' },
      { id: 'project_started',   label: 'Project Started / Pending client start' },
    ],
  },
  {
    id: 'production', label: 'Production', color: '#0EA5E9',
    stages: [
      { id: 'in_production',          label: 'Production' },
      { id: 'amends_2',               label: 'Amends 2' },
      { id: 'signed_off',             label: 'Signed Off' },
      { id: 'pending_group_sign_off', label: 'Pending Group Sign Off' },
      { id: 'back_up',                label: 'Back-up' },
      { id: 'on_hold',                label: 'On Hold' },
      { id: 'reserved',               label: 'Reserved' },
      { id: 'reserved_express',       label: 'Reserved (Express - Cannot move)' },
      { id: 'days_off_various',       label: 'Days Off / Various' },
    ],
  },
  {
    id: 'completed', label: 'Completed', color: '#16A34A',
    stages: [
      { id: 'delivered', label: 'Delivered' },
      { id: 'invoiced',  label: 'Invoiced' },
    ],
  },
  {
    id: 'after_care', label: 'After Care', color: '#A78BFA',
    stages: [
      { id: 'active', label: 'Active' },
      { id: 'closed', label: 'Closed' },
    ],
  },
];

// Where a deal lands the moment it's paid.
export const FIRST_PRODUCTION = { phase: 'pre_production', stage: 'new_project' };

export const PHASE_BY_ID = Object.fromEntries(PRODUCTION_PHASES.map(p => [p.id, p]));

// { phaseId: 'Label' } and { phaseId: { stageId: 'Label' } } for pills/badges.
export const PHASE_LABEL = Object.fromEntries(PRODUCTION_PHASES.map(p => [p.id, p.label]));
export const STAGE_LABEL = Object.fromEntries(
  PRODUCTION_PHASES.map(p => [p.id, Object.fromEntries(p.stages.map(s => [s.id, s.label]))])
);

export function phaseStages(phaseId) {
  return PHASE_BY_ID[phaseId]?.stages || [];
}

// Validates a (phase, stage) pair against the canonical list. Used by the API
// move endpoint so a bad client payload can't write a nonsense stage.
export function isValidProductionStage(phaseId, stageId) {
  const phase = PHASE_BY_ID[phaseId];
  return !!phase && phase.stages.some(s => s.id === stageId);
}

export function isValidVideoStatus(statusId) {
  return VIDEO_STATUSES.some(s => s.id === statusId);
}

export function isValidPaymentTerms(id) {
  return id == null || PAYMENT_TERMS.some(t => t.id === id);
}

// Per-video production status (independent of the project's overall stage).
export const VIDEO_STATUSES = [
  { id: 'not_started', label: 'Not started', color: '#94A3B8' },
  { id: 'scripting',   label: 'Scripting',   color: '#7C3AED' },
  { id: 'storyboard',  label: 'Storyboard',  color: '#FB923C' },
  { id: 'filming',     label: 'Filming',     color: '#0EA5E9' },
  { id: 'editing',     label: 'Editing',     color: '#2BB8E6' },
  { id: 'review',      label: 'In review',   color: '#F59E0B' },
  { id: 'approved',    label: 'Approved',    color: '#16A34A' },
  { id: 'delivered',   label: 'Delivered',   color: '#0F766E' },
];
export const VIDEO_STATUS_BY_ID = Object.fromEntries(VIDEO_STATUSES.map(s => [s.id, s]));

// Monday "Payment" column.
export const PAYMENT_TERMS = [
  { id: '50_50',        label: '50/50' },
  { id: 'full_upfront', label: 'Full up-front' },
  { id: 'po',           label: 'PO' },
];
export const PAYMENT_TERMS_LABEL = Object.fromEntries(PAYMENT_TERMS.map(t => [t.id, t.label]));

// ── Per-video milestones (Script → Visual Direction → Storyboard → Video). Each
// approval advances the video card to a mapped board stage (forward-only).
// Mirror of the copy in api/_lib/productionStages.js — keep in lockstep. ──
export const VIDEO_MILESTONES = [
  { id: 'script',           label: 'Script',           phase: 'pre_production', stage: 'scripts_completed' },
  { id: 'visual_direction', label: 'Visual Direction', phase: 'pre_production', stage: 'storyboard' },
  { id: 'storyboard',       label: 'Storyboard',       phase: 'pre_production', stage: 'project_started' },
  { id: 'video',            label: 'Video',            phase: 'production',     stage: 'signed_off' },
];
export const VIDEO_MILESTONE_BY_ID = Object.fromEntries(VIDEO_MILESTONES.map(m => [m.id, m]));

export function isValidMilestone(id) {
  return VIDEO_MILESTONES.some(m => m.id === id);
}

// Global ordering of every (phase, stage) so a milestone approval only ever
// moves a card forward. Returns -1 for an unknown pair.
const STAGE_ORDER = PRODUCTION_PHASES.flatMap(p => p.stages.map(s => p.id + ':' + s.id));
export function stageOrderIndex(phaseId, stageId) {
  return STAGE_ORDER.indexOf(phaseId + ':' + stageId);
}
