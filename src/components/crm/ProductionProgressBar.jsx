import React from 'react';
import { BRAND } from '../../theme.js';
import { PRODUCTION_PHASES } from '../../lib/productionStages.js';

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
