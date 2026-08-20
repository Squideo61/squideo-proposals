// Shared "steps completed" checklist + "portal activity" timeline (incl. logins)
// for the deal and organisation Customer-portal cards. Fed by the `steps` and
// `activity` arrays that /api/crm/portal-admin now returns for a deal or company.
import React, { useState } from 'react';
import {
  CheckCircle2, Circle, Clock, Upload, Sparkles, FileText, LogIn,
  PenLine, PoundSterling, FileCheck2, Mic, UserPlus, ChevronRight, Video,
} from 'lucide-react';
import { BRAND } from '../../theme.js';
import { formatRelativeTime } from '../../utils.js';
import { Modal } from '../ui.jsx';

const TYPE_ICONS = {
  login: LogIn, signed: PenLine, paid: PoundSterling, po: FileCheck2,
  file: Upload, extra: Sparkles, voiceover: Mic, quote: FileText, joined: UserPlus,
};

const exactTime = (iso) => { try { return new Date(iso).toLocaleString('en-GB'); } catch { return ''; } };
const shortDate = (iso) => { try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); } catch { return ''; } };
// e.g. "Tue 5 Aug, 14:30" — the booked kick-off time, in the viewer's locale.
const meetingWhen = (iso) => {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch { return ''; }
};

function ActivityRow({ a }) {
  const Icon = TYPE_ICONS[a.type] || Clock;
  const meta = [a.actor, a.type === 'login' ? a.loc : null].filter(Boolean).join(' · ');
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 0', fontSize: 12.5 }}>
      <Icon size={13} color={BRAND.muted} style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: BRAND.ink }}>
          {a.link ? <a href={a.link} style={{ color: BRAND.ink, textDecoration: 'none' }}>{a.text}</a> : a.text}
        </div>
        {meta && <div style={{ fontSize: 11, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta}</div>}
      </div>
      <span title={exactTime(a.at)} style={{ color: BRAND.muted, fontSize: 11, flexShrink: 0, whiteSpace: 'nowrap' }}>{formatRelativeTime(a.at)}</span>
    </div>
  );
}

function SectionHeader({ children }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, margin: '12px 0 6px' }}>
      {children}
    </div>
  );
}

// One deal's ordered step checklist (deal card).
function DealSteps({ steps }) {
  return (
    <div>
      {steps.map((s) => (
        <div key={s.key} style={{ padding: '4px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
            {s.done
              ? <CheckCircle2 size={14} color="#16A34A" style={{ flexShrink: 0 }} />
              : <Circle size={14} color={s.current ? BRAND.blue : BRAND.border} style={{ flexShrink: 0 }} />}
            <span style={{ flex: 1, color: s.done ? BRAND.ink : BRAND.muted, fontWeight: s.current ? 600 : 400 }}>{s.label}</span>
            {s.current && !s.done && (
              <span style={{ fontSize: 10, fontWeight: 700, color: BRAND.blue, background: '#EAF3FF', padding: '1px 6px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.4 }}>Next</span>
            )}
            {s.done && s.at && <span style={{ fontSize: 11, color: BRAND.muted, flexShrink: 0 }}>{shortDate(s.at)}</span>}
          </div>
          {/* Booked kick-off call: show the confirmed time + a one-click join.
              Reflects the latest reschedule (server returns the live booking). */}
          {s.meeting?.startsAt && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '3px 0 2px 22px', fontSize: 11.5 }}>
              <Video size={12} color={BRAND.blue} style={{ flexShrink: 0 }} />
              <span style={{ color: BRAND.muted }}>{meetingWhen(s.meeting.startsAt)}</span>
              {s.meeting.joinUrl && (
                <a
                  href={s.meeting.joinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 11, fontWeight: 700, color: BRAND.blue, textDecoration: 'none', background: '#EAF3FF', padding: '2px 8px', borderRadius: 5, whiteSpace: 'nowrap' }}
                >
                  Join call
                </a>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// Per-deal progress rollup across an org's live projects (company card).
function CompanySteps({ steps, onOpenDeal }) {
  return (
    <div>
      {steps.map((d) => {
        const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
        return (
          <button
            key={d.dealId}
            onClick={() => onOpenDeal?.(d.dealId)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '7px 0', border: 'none', borderBottom: '1px solid ' + BRAND.border, background: 'none', cursor: onOpenDeal ? 'pointer' : 'default', textAlign: 'left', fontFamily: 'inherit' }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title || 'Untitled project'}</div>
              <div style={{ fontSize: 11, color: BRAND.muted }}>{d.done}/{d.total} steps{d.currentLabel ? ` · next: ${d.currentLabel}` : ' · complete'}</div>
              <div style={{ height: 4, background: BRAND.border, borderRadius: 3, marginTop: 4, overflow: 'hidden' }}>
                <div style={{ width: pct + '%', height: '100%', background: pct === 100 ? '#16A34A' : BRAND.blue }} />
              </div>
            </div>
            {onOpenDeal && <ChevronRight size={14} color={BRAND.muted} style={{ flexShrink: 0 }} />}
          </button>
        );
      })}
    </div>
  );
}

const INLINE_LIMIT = 6;

// `sections` splits the two halves so a caller can place them apart. The deal
// page does: the checklist is where the client is UP TO — the thing you open
// the card to find out — while the activity log is a trail you consult, so it
// belongs at the bottom. Defaults to both, which is how the company card and
// every other caller still use it.
export function PortalStepsActivity({ variant, steps = [], activity = [], onOpenDeal, sections = 'both' }) {
  const [showAll, setShowAll] = useState(false);
  const shown = activity.slice(0, INLINE_LIMIT);

  return (
    <div style={{ borderTop: '1px solid ' + BRAND.border, marginTop: 10, paddingTop: 2 }}>
      {sections !== 'activity' && steps.length > 0 && (
        <>
          <SectionHeader>{variant === 'company' ? 'Project progress' : 'Steps completed'}</SectionHeader>
          {variant === 'company'
            ? <CompanySteps steps={steps} onOpenDeal={onOpenDeal} />
            : <DealSteps steps={steps} />}
        </>
      )}

      {sections !== 'steps' && (
        <>
          <SectionHeader>Portal activity</SectionHeader>
          {activity.length === 0 ? (
            <div style={{ fontSize: 12.5, color: BRAND.muted, fontStyle: 'italic', paddingBottom: 4 }}>
              Nothing yet — logins, uploads, voiceover picks and other portal actions show here.
            </div>
          ) : (
            <>
              {shown.map((a, i) => <ActivityRow key={i} a={a} />)}
              {activity.length > INLINE_LIMIT && (
                <button className="btn-ghost" style={{ fontSize: 12, marginTop: 4 }} onClick={() => setShowAll(true)}>
                  View all {activity.length} events
                </button>
              )}
            </>
          )}
        </>
      )}

      {showAll && (
        <Modal onClose={() => setShowAll(false)} maxWidth={560}>
          <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700, color: BRAND.ink }}>Portal activity</h3>
          <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 10 }}>Logins and client actions, newest first.</div>
          <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
            {activity.map((a, i) => <ActivityRow key={i} a={a} />)}
          </div>
        </Modal>
      )}
    </div>
  );
}
