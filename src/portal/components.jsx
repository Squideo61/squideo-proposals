// Shared portal UI bits — built on the same BRAND tokens as the CRM's client
// pages (ClientView / VideoRevision are the visual precedent).
import React from 'react';
import { BRAND } from '../theme.js';
import {
  Zap, CheckCircle2, Clapperboard, ChevronRight, Download, FileText,
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
