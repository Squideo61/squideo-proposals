import React from 'react';
import { BRAND } from '../../theme.js';
import { PRODUCTION_PHASES, PHASE_BY_ID, stageOrderIndex } from '../../lib/productionStages.js';

// A pipeline-style progress bar over the four production PHASES
// (Pre-Production → Production → Completed → After Care). Used in two places,
// the same shape in both so a project and its videos read alike:
//   • per video  — `onPhaseChange` set, so the segments are clickable to move
//                  the video to that phase's first stage.
//   • per project — read-only; `phaseId` is the aggregate (least-advanced video)
//                  and `subtitle` carries the "X of N delivered" counter.
export function ProductionProgressBar({ phaseId, onPhaseChange = null, subtitle = null }) {
  const activeIdx = Math.max(0, PRODUCTION_PHASES.findIndex(p => p.id === phaseId));
  const clickable = typeof onPhaseChange === 'function';

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', borderRadius: 8, overflow: 'hidden', border: '1px solid ' + BRAND.border }}>
        {PRODUCTION_PHASES.map((p, i) => {
          const active = i === activeIdx;
          const past = i < activeIdx;
          const Tag = clickable ? 'button' : 'div';
          return (
            <Tag
              key={p.id}
              onClick={clickable ? () => onPhaseChange(p.id) : undefined}
              title={clickable ? `Move to ${p.label}` : p.label}
              style={{
                flex: '1 1 auto',
                padding: '7px 10px',
                border: 'none',
                borderLeft: i > 0 ? '1px solid rgba(0,0,0,0.12)' : 'none',
                background: active ? p.color : past ? p.color + '33' : '#F1F5F9',
                color: active ? 'white' : past ? p.color : BRAND.muted,
                fontSize: 11,
                fontWeight: active ? 700 : 500,
                cursor: clickable ? 'pointer' : 'default',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
                textAlign: 'center',
              }}
            >
              {p.label}
            </Tag>
          );
        })}
      </div>
      {subtitle && (
        <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 6 }}>{subtitle}</div>
      )}
    </div>
  );
}

// The detailed per-video bar: the key forward stages spanning all phases (the
// "happy path"; side-states like Amends / On Hold / Reserved are reached via
// the Stage dropdown). Each segment is a real board stage, so clicking moves
// the video straight there (including across phases). The active segment is the
// furthest step at or before the video's current board position, so an in-
// between stage (e.g. Amends 1) lights the step it follows and the exact stage
// shows in the caption beneath.
const VIDEO_STEPS = [
  { label: 'New Project',     phase: 'pre_production', stage: 'new_project' },
  { label: 'Script',          phase: 'pre_production', stage: 'script' },
  { label: 'Storyboard',      phase: 'pre_production', stage: 'storyboard' },
  { label: 'Project Started', phase: 'pre_production', stage: 'project_started' },
  { label: 'Production',      phase: 'production',     stage: 'in_production' },
  { label: 'Signed Off',      phase: 'production',     stage: 'signed_off' },
  { label: 'Delivered',       phase: 'completed',      stage: 'delivered' },
];

export function VideoProgressBar({ phaseId, stageId, onMove = null }) {
  const curIdx = stageOrderIndex(phaseId, stageId);
  let activeStepI = 0;
  VIDEO_STEPS.forEach((s, i) => { if (stageOrderIndex(s.phase, s.stage) <= curIdx) activeStepI = i; });
  const clickable = typeof onMove === 'function';

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', borderRadius: 8, overflow: 'hidden', border: '1px solid ' + BRAND.border }}>
      {VIDEO_STEPS.map((s, i) => {
        const color = PHASE_BY_ID[s.phase]?.color || BRAND.blue;
        const active = i === activeStepI;
        const done = i < activeStepI;
        const Tag = clickable ? 'button' : 'div';
        return (
          <Tag
            key={s.label}
            onClick={clickable ? () => onMove(s.phase, s.stage) : undefined}
            title={clickable ? `Move to ${s.label}` : s.label}
            style={{
              flex: '1 1 auto',
              padding: '7px 8px',
              border: 'none',
              borderLeft: i > 0 ? '1px solid rgba(0,0,0,0.12)' : 'none',
              background: active ? color : done ? color + '2e' : '#F1F5F9',
              color: active ? 'white' : done ? color : BRAND.muted,
              fontSize: 11,
              fontWeight: active ? 700 : 500,
              cursor: clickable ? 'pointer' : 'default',
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
              textAlign: 'center',
            }}
          >
            {done ? '✓ ' : ''}{s.label}
          </Tag>
        );
      })}
    </div>
  );
}

// Shared helpers so the project bar aggregates videos consistently.
const PHASE_INDEX = Object.fromEntries(PRODUCTION_PHASES.map((p, i) => [p.id, i]));
const COMPLETED_INDEX = PRODUCTION_PHASES.findIndex(p => p.id === 'completed');

export function phaseIndexOf(phaseId) {
  return phaseId in PHASE_INDEX ? PHASE_INDEX[phaseId] : 0;
}

// A project is only as far along as its least-advanced video; a video counts as
// "delivered" once it reaches the Completed phase (delivered / invoiced) or
// After Care. Returns { phaseId, delivered, total }.
export function aggregateProjectPhase(videos = []) {
  const list = videos.filter(Boolean);
  if (!list.length) return { phaseId: PRODUCTION_PHASES[0].id, delivered: 0, total: 0 };
  let minIdx = Infinity;
  let delivered = 0;
  for (const v of list) {
    const idx = phaseIndexOf(v.productionPhase);
    if (idx < minIdx) minIdx = idx;
    if (idx >= COMPLETED_INDEX) delivered += 1;
  }
  return { phaseId: PRODUCTION_PHASES[minIdx]?.id || PRODUCTION_PHASES[0].id, delivered, total: list.length };
}
