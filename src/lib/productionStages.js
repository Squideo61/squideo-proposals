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
      { id: 'awaiting_feedback_1', label: 'Awaiting Feedback' },
      { id: 'project_started',   label: 'Project Started / Pending client start' },
    ],
  },
  {
    id: 'production', label: 'Production', color: '#0EA5E9',
    stages: [
      { id: 'in_production',          label: 'Production' },
      { id: 'amends_2',               label: 'Amends 2' },
      { id: 'awaiting_feedback_2',    label: 'Awaiting Feedback' },
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

// A video counts as "signed off" (for credit-based project line items) once it
// reaches Signed Off / Pending Group Sign Off, or anything in the Completed
// phase (Delivered / Invoiced). Everything earlier — and holding stages like
// On Hold / Back-up — is still "active". Mirror of the copy in
// api/_lib/productionStages.js.
export function isVideoSignedOff(phaseId, stageId) {
  return phaseId === 'completed' ||
    (phaseId === 'production' && (stageId === 'signed_off' || stageId === 'pending_group_sign_off'));
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

// Payment plan as chosen on the signed proposal (signature_data.paymentOption).
// Read-only on the video/board — the proposal is the source of truth.
export const PAYMENT_OPTION_LABEL = { '5050': '50/50', full: 'Full up-front', po: 'PO' };

// Video-length presets for the card dropdown. The stored value is the label
// string; `days` is what the weekly scheduler assigns per stage (also derived
// by durationDaysForLength in scheduleCalendar.js — keep the two consistent).
// "Other" lets Callum type a custom length; if he adds "… N days" the scheduler
// honours it, otherwise it defaults to 1 day and he tweaks it on the calendar.
// Mirror of the copy in api/_lib/productionStages.js.
export const VIDEO_LENGTH_OPTIONS = [
  { value: '30 seconds (70w)',  words: 70,  days: 1 },
  { value: '1 minute (140w)',   words: 140, days: 1 },
  { value: '1.5 minutes (210w)', words: 210, days: 2 },
  { value: '2 minutes (280w)',  words: 280, days: 2 },
  { value: '2.5 minutes (350w)', words: 350, days: 3 },
  { value: '3 minutes (420w)',  words: 420, days: 3 },
  { value: '3.5 minutes (490w)', words: 490, days: 4 },
  { value: '4 minutes (560w)',  words: 560, days: 4 },
  { value: '5 minutes (700w)',  words: 700, days: 5 },
];
export const VIDEO_LENGTH_VALUES = new Set(VIDEO_LENGTH_OPTIONS.map(o => o.value));

// ── Per-video milestones (Script & Text Direction → Storyboard → Video). Each
// approval advances the video card to a mapped board stage (forward-only).
// Script and text/visual direction are sent to the client together, so they
// share one milestone (the legacy 'visual_direction' milestone was folded into
// 'script'). Mirror of the copy in api/_lib/productionStages.js — keep in
// lockstep. ──
export const VIDEO_MILESTONES = [
  { id: 'script',     label: 'Script & Text Direction', phase: 'pre_production', stage: 'storyboard' },
  { id: 'storyboard', label: 'Storyboard',              phase: 'pre_production', stage: 'project_started' },
  { id: 'video',      label: 'Video',                   phase: 'production',     stage: 'signed_off' },
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

// Which deliverable the video page should preview at a given board position:
// 'script' early in pre-production, 'storyboard' during storyboarding, then
// 'video' once it heads into production. Drives the stage-locked preview pane.
export function previewKindForStage(phaseId, stageId) {
  if (phaseId === 'pre_production') {
    if (stageId === 'storyboard' || stageId === 'amends_1' || stageId === 'awaiting_feedback_1') return 'storyboard';
    if (stageId === 'project_started') return 'video';
    return 'script'; // new_project, script, scripts_completed
  }
  return 'video'; // production / completed / after_care
}
