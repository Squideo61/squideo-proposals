// Shared portal UI bits — built on the same BRAND tokens as the CRM's client
// pages (ClientView / VideoRevision are the visual precedent).
import React from 'react';
import { BRAND } from '../theme.js';
import {
  Zap, CheckCircle2, Clapperboard, ChevronRight, Download, FileText,
  Mic, CalendarClock, ClipboardList, Check, Circle,
} from 'lucide-react';

export const fmtGBP = (n) =>
  '£' + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export const fmtBytes = (n) => {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024 * 1024) return (b / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' KB';
  return b + ' B';
};

export const fmtDate = (d) => {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return ''; }
};

export function Card({ children, style, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: '#fff',
        border: `1px solid ${BRAND.border}`,
        borderRadius: 14,
        padding: 20,
        cursor: onClick ? 'pointer' : undefined,
        transition: 'box-shadow 0.15s ease, transform 0.15s ease',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// The ball-in-court banner — the loudest element on every project card.
const COURT_STYLES = {
  you: {
    bg: '#FFF8EB', border: '#F5C26B', accent: '#B45309',
    chip: '#F59E0B', chipText: '#fff', chipLabel: 'Action needed from you',
    Icon: Zap,
  },
  squideo: {
    bg: '#EAF7FC', border: '#A9E1F5', accent: '#0B6E93',
    chip: BRAND.blue, chipText: '#fff', chipLabel: 'In production with Squideo',
    Icon: Clapperboard,
  },
  done: {
    bg: '#EDFBF2', border: '#9BE0B7', accent: '#15803D',
    chip: '#16A34A', chipText: '#fff', chipLabel: 'Delivered',
    Icon: CheckCircle2,
  },
};

export function CourtBanner({ nextStep, onCta, compact = false }) {
  if (!nextStep) return null;
  const s = COURT_STYLES[nextStep.court] || COURT_STYLES.squideo;
  const Icon = s.Icon;
  return (
    <div style={{
      background: s.bg,
      border: `1px solid ${s.border}`,
      borderRadius: 12,
      padding: compact ? '12px 14px' : '16px 18px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: s.chip, color: s.chipText, borderRadius: 999,
          padding: '3px 10px', fontSize: 12, fontWeight: 700,
        }}>
          <Icon size={13} /> {s.chipLabel}
        </span>
      </div>
      <div style={{ fontWeight: 700, fontSize: compact ? 14 : 16, color: BRAND.ink }}>{nextStep.headline}</div>
      {!compact && nextStep.detail && (
        <div style={{ fontSize: 13, color: '#4B5A66', marginTop: 6, lineHeight: 1.5 }}>{nextStep.detail}</div>
      )}
      {nextStep.cta && (
        <div style={{ marginTop: compact ? 8 : 12 }}>
          <button
            className="btn"
            style={{ background: nextStep.court === 'you' ? '#F59E0B' : BRAND.blue }}
            onClick={(e) => { e.stopPropagation(); onCta?.(nextStep.cta); }}
          >
            {nextStep.cta.label} <ChevronRight size={15} style={{ verticalAlign: -3 }} />
          </button>
        </div>
      )}
    </div>
  );
}

// Phase progress: Pre-Production → Production → Completed → After Care.
const PHASES = [
  { id: 'pre_production', label: 'Pre-Production' },
  { id: 'production', label: 'Production' },
  { id: 'completed', label: 'Completed' },
  { id: 'after_care', label: 'After Care' },
];

export function PhaseTimeline({ production }) {
  const activeIdx = PHASES.findIndex((p) => p.id === production?.phase);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0 }}>
      {PHASES.map((p, i) => {
        const done = activeIdx > i || production?.phase === 'after_care' && i <= activeIdx;
        const active = activeIdx === i;
        const color = done ? '#16A34A' : active ? BRAND.blue : '#D3DCE3';
        return (
          <React.Fragment key={p.id}>
            {i > 0 && (
              <div style={{
                flex: 1, height: 3, marginTop: 9, borderRadius: 2,
                background: activeIdx >= i ? '#16A34A' : '#E5E9EE',
                minWidth: 12,
              }} />
            )}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, minWidth: 0 }}>
              <div style={{
                width: 20, height: 20, borderRadius: '50%',
                background: done ? '#16A34A' : active ? BRAND.blue : '#fff',
                border: `3px solid ${color}`,
                boxShadow: active ? `0 0 0 4px ${BRAND.blue}22` : undefined,
                transition: 'all 0.3s ease',
              }} />
              <div style={{
                fontSize: 10.5, fontWeight: active ? 700 : 500,
                color: active ? BRAND.ink : done ? '#15803D' : BRAND.muted,
                textAlign: 'center', whiteSpace: 'nowrap',
              }}>
                {p.label}
              </div>
              {active && production?.stageLabel && (
                <div style={{ fontSize: 10, color: BRAND.blue, fontWeight: 600, textAlign: 'center', maxWidth: 110 }}>
                  {production.stageLabel}
                </div>
              )}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// The production schedule, as a client reads it.
//
// Two things earn this its space. One: it answers "when do I see something?"
// without anyone having to ask. Two — and this is the reason it's worth the
// pixels — it makes the client's OWN deadlines visible. A project slips most
// often because nobody told them their week was the critical path, so the
// "Your feedback due" rows are marked out in amber and everything we owe them
// sits in blue.
//
// Dates that have passed are ticked and dimmed; the next one still to come is
// the only row that gets any weight. No progress percentages and no "on track"
// claims — a plan is a plan, and dressing it as live status would be the first
// thing to become a lie when something moves.
export function ProjectSchedule({ schedule, title = 'Timeline', compact = false }) {
  const milestones = schedule?.milestones || [];
  if (!milestones.length) return null;

  // Compared as YYYY-MM-DD strings against local today — no timezone maths on a
  // value that was authored as a plain day in the first place.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const nextIdx = milestones.findIndex((m) => m.date >= today);

  return (
    <div>
      {title && (
        <div style={{
          fontSize: 11.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.4,
          color: BRAND.muted, margin: '0 0 10px',
        }}>
          {title}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {milestones.map((m, i) => {
          const past = m.date < today;
          const next = i === nextIdx;
          const yours = m.who === 'you';
          const accent = yours ? '#B45309' : BRAND.blue;
          const last = i === milestones.length - 1;
          return (
            <div key={m.key} style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
              {/* Rail: dot plus the line down to the next one. */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 16, flexShrink: 0 }}>
                <span style={{
                  width: 11, height: 11, borderRadius: '50%', marginTop: 5, flexShrink: 0,
                  background: past ? '#CBD5E1' : accent,
                  boxShadow: next ? `0 0 0 4px ${accent}22` : 'none',
                }} />
                {!last && <span style={{ flex: 1, width: 2, background: '#E5E9EE', minHeight: compact ? 14 : 18 }} />}
              </div>

              <div style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : compact ? 12 : 16 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: compact ? 13 : 13.5, fontWeight: next ? 800 : 700,
                    color: past ? BRAND.muted : BRAND.ink,
                  }}>
                    {m.label}
                  </span>
                  {yours && !past && (
                    <span style={{
                      background: '#FEF3C7', color: '#B45309', border: '1px solid #FDE68A',
                      borderRadius: 999, padding: '1px 8px', fontSize: 10.5, fontWeight: 800,
                      textTransform: 'uppercase', letterSpacing: 0.3,
                    }}>
                      You
                    </span>
                  )}
                  {next && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: accent }}>Next up</span>
                  )}
                </div>
                <div style={{
                  fontSize: compact ? 12 : 12.5, color: BRAND.muted, marginTop: 2,
                  display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
                }}>
                  {past && <Check size={12} color="#16A34A" style={{ flexShrink: 0 }} />}
                  <span>{m.event}</span>
                  <span style={{ color: '#C3D3DC' }}>·</span>
                  <span style={{ fontWeight: 600, color: past ? BRAND.muted : BRAND.ink }}>
                    {fmtScheduleDate(m.date)}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 10, lineHeight: 1.5 }}>
        Planned dates — we'll let you know here if anything moves.
      </div>
    </div>
  );
}

// "Tue 12 Aug", plus the year when it isn't this one. Parsed as parts rather
// than `new Date('2026-08-12')`, which some browsers read as UTC midnight and
// render as the day before for anyone west of London.
function fmtScheduleDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return ymd || '';
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-GB', opts);
}

export function StatusPill({ label, color }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 999,
      background: (color || '#94A3B8') + '1c', color: color || '#64748B',
      fontSize: 11.5, fontWeight: 700,
    }}>
      {label}
    </span>
  );
}

export function EmptyState({ icon = null, title, body, action }) {
  return (
    <div style={{ textAlign: 'center', padding: '44px 20px', color: BRAND.muted }}>
      {icon && <div style={{ marginBottom: 12, opacity: 0.6 }}>{icon}</div>}
      <div style={{ fontWeight: 700, color: BRAND.ink, fontSize: 15, marginBottom: 6 }}>{title}</div>
      {body && <div style={{ fontSize: 13, lineHeight: 1.55, maxWidth: 380, margin: '0 auto' }}>{body}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

export function FileRow({ filename, sizeBytes, createdAt, meta, onDownload, onDelete, downloading }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
      border: `1px solid ${BRAND.border}`, borderRadius: 10, background: '#fff',
    }}>
      <FileText size={18} color={BRAND.muted} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {filename}
        </div>
        <div style={{ fontSize: 11.5, color: BRAND.muted }}>
          {[sizeBytes != null ? fmtBytes(sizeBytes) : null, fmtDate(createdAt), meta].filter(Boolean).join(' · ')}
        </div>
      </div>
      {onDownload && (
        <button className="btn-ghost" onClick={onDownload} disabled={downloading} title="Download" style={{ padding: '6px 10px' }}>
          <Download size={15} style={{ verticalAlign: -3 }} />
        </button>
      )}
      {onDelete && (
        <button className="btn-ghost" onClick={onDelete} title="Remove" style={{ padding: '6px 10px', color: '#DC2626' }}>✕</button>
      )}
    </div>
  );
}

export function SectionHeading({ children, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 12px' }}>
      <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: BRAND.ink }}>{children}</h2>
      {right}
    </div>
  );
}

// Icon per task key, so a new task type gets a sensible default.
const TASK_ICON = { po: ClipboardList, voiceover: Mic, kickoff: CalendarClock, script: FileText };

// The client's "Your tasks" checklist, shared by the dashboard project card and
// the project detail page. `onCta(cta)` runs the task's action/deep-link.
export function ProjectTasks({ tasks = [], onCta, compact = false }) {
  if (!tasks.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 6 : 8 }}>
      {tasks.map((t) => {
        const Icon = TASK_ICON[t.key] || Circle;
        const done = t.status === 'done';
        const clickable = !!t.cta && !!onCta;
        const go = (e) => { e.stopPropagation(); if (clickable) onCta(t.cta); };
        return (
          <button
            key={t.key}
            onClick={go}
            disabled={!clickable}
            style={{
              display: 'flex', alignItems: 'center', gap: compact ? 10 : 12, textAlign: 'left', width: '100%',
              padding: compact ? '9px 11px' : '12px 14px', borderRadius: 10,
              cursor: clickable ? 'pointer' : 'default',
              border: `1px solid ${BRAND.border}`, background: done ? '#F6FBF7' : '#FFFDF5',
            }}
          >
            <div style={{
              width: compact ? 26 : 30, height: compact ? 26 : 30, borderRadius: 8, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: done ? '#DCFCE7' : '#FEF3C7', color: done ? '#16A34A' : '#B45309',
            }}>
              {done ? <Check size={15} /> : <Icon size={15} />}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: compact ? 13 : 13.5, fontWeight: 700, color: BRAND.ink }}>{t.title}</div>
              <div style={{ fontSize: compact ? 11.5 : 12, color: BRAND.muted, lineHeight: 1.45 }}>{t.detail}</div>
            </div>
            {t.cta && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, fontWeight: 700, color: done ? BRAND.muted : BRAND.blue, flexShrink: 0 }}>
                {t.cta.label} <ChevronRight size={14} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
