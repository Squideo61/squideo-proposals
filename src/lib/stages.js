// Canonical pipeline-stage definitions, used by the web app (PIPELINE_STAGES)
// and mirrored into extension/src/lib/stages.js (build isolation means we
// keep a copy there rather than importing across the boundary). Keep the
// two files in lockstep — change here, then copy the file across.

// Colours follow the Streak pipeline's left-to-right rainbow (red → orange →
// gold → lime → green → teal → blue → violet) by funnel position, so the board
// reads the same as the team's Streak. `color` is the accent (chevron fill /
// header text), `bg`/`fg` the light/dark chip pair. Lost has no Streak
// equivalent, so it stays a neutral slate (terminal, not alarming red).
export const PIPELINE_STAGES = [
  { id: 'lead',          label: 'Lead',          color: '#E04331', bg: '#FCEAE7', fg: '#B23121' },
  { id: 'responded',     label: 'Responded',     color: '#F07F1A', bg: '#FEEFE0', fg: '#B45309' },
  { id: 'proposal_sent', label: 'Proposal Sent', color: '#E0A400', bg: '#FBF3D6', fg: '#8A6400' },
  { id: 'viewed',        label: 'Viewed',        color: '#93AE12', bg: '#F1F6D8', fg: '#586A07' },
  { id: 'interested',    label: 'Interested',    color: '#46A84D', bg: '#E7F4E8', fg: '#2C7A33' },
  { id: 'signed',        label: 'Signed',        color: '#12A294', bg: '#DEF4F1', fg: '#0C6F65' },
  { id: 'paid',          label: 'Paid',          color: '#2E84D4', bg: '#E6F0FB', fg: '#1B5896' },
  { id: 'long_term',     label: 'Long-term',     color: '#9B4BC4', bg: '#F4E9FA', fg: '#6B21A8', defaultCollapsed: true },
  { id: 'lost',          label: 'Lost',          color: '#94A3B8', bg: '#EEF2F6', fg: '#475569', defaultCollapsed: true },
];

// Extension chip palette: { stageId: { bg, fg } }. Derived from PIPELINE_STAGES.
export const STAGE_COLOURS = Object.fromEntries(
  PIPELINE_STAGES.map(s => [s.id, { bg: s.bg, fg: s.fg }])
);

// { stageId: 'Human label' } — used for stage pills/badges.
export const STAGE_LABEL = Object.fromEntries(
  PIPELINE_STAGES.map(s => [s.id, s.label])
);
