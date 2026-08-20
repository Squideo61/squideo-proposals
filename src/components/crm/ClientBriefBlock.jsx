// The client's own video brief, on the deal it belongs to.
//
// The brief builder was a lead magnet: someone filled one in, it became a quote
// request, and that was the end of it. Clients then started sending briefs for
// work they had already signed — which had nowhere to land, so the answers sat
// in the portal and the team worked from an email instead.
//
// Now a brief names its project, so it shows here. Deliberately including
// DRAFTS: the expensive mistake is finding out at storyboard stage that the
// audience was never who we assumed, and a half-finished brief says that a
// fortnight earlier than a finished one.
//
// Presentational only — fed by `briefs` from /api/crm/portal-admin?dealId=…,
// which the Client portal card already loads.
import React, { useState } from 'react';
import { ClipboardList, ChevronDown, ChevronRight, Lock, Users, History } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { formatRelativeTime } from '../../utils.js';

function BriefRow({ brief }) {
  const [open, setOpen] = useState(false);
  const [showActivity, setShowActivity] = useState(false);

  return (
    <div style={{ borderBottom: '1px solid ' + BRAND.border }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
          padding: '8px 0', background: 'transparent', border: 'none', cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {open ? <ChevronDown size={13} color={BRAND.muted} /> : <ChevronRight size={13} color={BRAND.muted} />}
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: BRAND.ink }}>
          {brief.title}
        </span>
        {brief.locked ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 7px',
            borderRadius: 999, background: '#F0FDF4', border: '1px solid #BBF7D0',
            fontSize: 10, fontWeight: 800, color: '#15803D', letterSpacing: 0.3,
          }}><Lock size={9} /> FINAL</span>
        ) : (
          <span style={{ fontSize: 11.5, color: BRAND.muted }}>{brief.done}/{brief.total}</span>
        )}
        {brief.contributors > 1 && (
          <span style={{ fontSize: 11.5, color: BRAND.muted, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <Users size={11} />{brief.contributors}
          </span>
        )}
      </button>

      {open && (
        <div style={{ padding: '2px 0 12px 21px' }}>
          <div style={{ fontSize: 11.5, color: BRAND.muted, marginBottom: 8 }}>
            {brief.locked
              ? `Finalised${brief.submittedBy ? ` by ${brief.submittedBy}` : ''} ${formatRelativeTime(brief.submittedAt)}`
              : `Still a draft — last edited ${formatRelativeTime(brief.updatedAt)}. This may still change.`}
            {brief.reopenedAt && ' · reopened by Squideo'}
          </div>

          {brief.text ? (
            <div style={{
              whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.55, color: BRAND.ink,
              background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 8,
              padding: '10px 12px', maxHeight: 340, overflowY: 'auto',
            }}>{brief.text}</div>
          ) : (
            <div style={{ fontSize: 12.5, color: BRAND.muted, fontStyle: 'italic' }}>
              Started, but nothing answered yet.
            </div>
          )}

          {brief.activity?.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setShowActivity((v) => !v)}
                aria-expanded={showActivity}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 8,
                  background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                  color: BRAND.blue, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                }}
              >
                <History size={12} />
                {showActivity ? 'Hide' : 'Who changed what'}
              </button>
              {showActivity && (
                <div style={{ marginTop: 6 }}>
                  {brief.activity.map((e) => (
                    <div key={e.id} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 11.5 }}>
                      <span style={{ flex: 1, minWidth: 0, color: BRAND.ink }}>{e.text}</span>
                      <span style={{ color: BRAND.muted, whiteSpace: 'nowrap' }}>
                        {formatRelativeTime(e.at)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ClientBriefBlock({ briefs }) {
  const [open, setOpen] = useState(false);
  if (!briefs?.length) return null;

  const drafts = briefs.filter((b) => !b.locked).length;

  return (
    <div style={{ marginTop: 12, borderTop: '1px solid ' + BRAND.border, paddingTop: 4 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Hide the client’s brief' : 'Read the brief the client wrote for this project'}
        style={{
          display: 'flex', alignItems: 'center', gap: 4, width: '100%', padding: '6px 0',
          background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
          textAlign: 'left', fontSize: 11, fontWeight: 700, color: BRAND.muted,
          textTransform: 'uppercase', letterSpacing: 0.5,
        }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <ClipboardList size={12} />
        Client brief
        <span style={{ opacity: 0.75 }}>· {briefs.length}</span>
        {drafts > 0 && (
          <span style={{ marginLeft: 'auto', color: '#B45309', textTransform: 'none', letterSpacing: 0 }}>
            {drafts} still a draft
          </span>
        )}
      </button>
      {open && briefs.map((b) => <BriefRow key={b.id} brief={b} />)}
    </div>
  );
}
