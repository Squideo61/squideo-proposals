import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Eye, MousePointerClick, ArrowUpRight, CheckSquare } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { formatRelativeTime } from '../utils.js';
import { sanitizeEmailBody } from '../utils/emailImages.js';

// Short, human date for the message header (e.g. "3 Jun 2026, 14:30").
function formatDateLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Mirrors the inline email viewer elsewhere: render real mail (images, links,
// tables) but strip scripts / inline handlers / style blocks.
const VIEW_SANITIZE = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
  FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
};
const sanitize = (html, messageId) => (html ? sanitizeEmailBody(html, VIEW_SANITIZE, { messageId }) : null);

// Opened from a "View Tracking" email-open alert. Loads the thread and surfaces
// the specific email the recipient opened — the last message WE sent (it carries
// the tracking pixel) — alongside its full open/click tracking, so there's no
// scrolling a long thread to find the relevant message.
export function EmailTrackingModal({ threadId, onClose, onOpenDeal }) {
  const { state, actions } = useStore();
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    actions.loadMailboxThread(threadId)
      .then((d) => { if (!cancelled) { setThread(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(e?.message || 'Could not load this email'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [threadId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const myEmail = (state.gmailAccount?.gmailAddress || '').toLowerCase();
  const messages = thread?.messages || [];
  // The tracked email = the message we sent (pixel lives in our outbound mail).
  // Prefer the most recent outbound message; fall back to the latest message.
  const tracked = [...messages].reverse().find((m) => (m.fromEmail || '').toLowerCase() === myEmail)
    || messages[messages.length - 1]
    || null;
  // Tracking for the specific sent email shown below (its own opens/clicks),
  // falling back to the thread-level summary if per-message data isn't present.
  const tracking = tracked?.tracking || thread?.tracking || null;
  const bodyHtml = tracked ? sanitize(tracked.html, tracked.id) : null;

  // The deal this email thread is linked to (if any), plus its next open task.
  const deal = (thread?.deals && thread.deals[0]) || null;
  const nextTask = useMemo(() => {
    if (!deal) return null;
    const open = (state.tasks || []).filter((t) => t.dealId === deal.dealId && !t.doneAt);
    open.sort((a, b) => {
      if (!a.dueAt) return b.dueAt ? 1 : 0;
      if (!b.dueAt) return -1;
      return new Date(a.dueAt) - new Date(b.dueAt);
    });
    return open[0] || null;
  }, [deal, state.tasks]);

  return createPortal(
    <div onMouseDown={onClose} style={OVERLAY}>
      <div onMouseDown={(e) => e.stopPropagation()} style={PANEL} role="dialog" aria-modal="true">
        <div style={HEADER}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <Eye size={18} color="#16A34A" style={{ flexShrink: 0 }} />
            <strong style={{ fontSize: 15, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {thread?.subject || tracked?.subject || 'Email tracking'}
            </strong>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {deal && onOpenDeal && (
              <button onClick={() => { onOpenDeal(deal.dealId); onClose(); }} className="btn">
                Go to Deal <ArrowUpRight size={14} />
              </button>
            )}
            <button onClick={onClose} aria-label="Close" className="btn-icon"><X size={16} /></button>
          </span>
        </div>

        <div style={SCROLL}>
          {loading ? (
            <div style={CENTER}>Loading…</div>
          ) : error ? (
            <div style={{ ...CENTER, color: BRAND.muted }}>{error}</div>
          ) : (
            <>
              {nextTask && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', marginBottom: 12, border: '1px solid ' + BRAND.border, borderRadius: 8, background: '#FAFBFC' }}>
                  <CheckSquare size={15} color={BRAND.blue} style={{ flexShrink: 0, marginTop: 1 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Next task</div>
                    <div style={{ fontSize: 13, color: BRAND.ink, marginTop: 2 }}>{nextTask.title}</div>
                    {nextTask.dueAt && (
                      <div style={{ fontSize: 11.5, color: new Date(nextTask.dueAt) < new Date() ? '#DC2626' : BRAND.muted, marginTop: 1 }}>
                        Due {new Date(nextTask.dueAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {tracking?.tracked
                ? <TrackingDetails tracking={tracking} />
                : <div style={{ fontSize: 12.5, color: BRAND.muted, padding: '8px 0' }}>No tracking recorded for this email.</div>}

              {tracked ? (
                <div style={{ marginTop: 14, border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ padding: '10px 12px', background: '#FAFBFC', borderBottom: '1px solid ' + BRAND.border }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ flexShrink: 0, padding: '1px 5px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: '#2BB8E622', color: '#2BB8E6' }}>OUT</span>
                      <span style={{ fontWeight: 600, fontSize: 13, color: BRAND.ink }}>{tracked.from || tracked.fromEmail || 'me'}</span>
                      <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 11, color: BRAND.muted }}>{formatDateLabel(tracked.date)}</span>
                    </div>
                    {tracked.to?.length ? <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 4 }}>to {tracked.to.join(', ')}</div> : null}
                  </div>
                  <div className="email-body" style={{ padding: 14, fontSize: 13.5, lineHeight: 1.6, wordBreak: 'break-word' }}>
                    {bodyHtml
                      ? <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />
                      : tracked.text
                        ? <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', margin: 0 }}>{tracked.text}</pre>
                        : <div style={{ color: BRAND.muted, fontStyle: 'italic' }}>(no body)</div>}
                  </div>
                </div>
              ) : (
                <div style={{ ...CENTER, color: BRAND.muted }}>Couldn’t find the sent email in this thread.</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Full open/click summary for the tracked send.
function TrackingDetails({ tracking }) {
  const opened = tracking.opens > 0;
  const locations = (tracking.locations || []).slice(0, 4);
  const urls = (tracking.clickedUrls || []).slice(0, 5);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
      <Stat
        accent={opened ? '#16A34A' : BRAND.muted}
        icon={<Eye size={15} />}
        title={opened ? `Opened ${tracking.opens}×` : 'Sent · not opened yet'}
        lines={[
          opened && tracking.lastOpenedAt ? `Last opened ${formatRelativeTime(tracking.lastOpenedAt)}` : null,
          locations.length ? locations.join(' · ') : null,
        ].filter(Boolean)}
      />
      {tracking.clicks > 0 && (
        <Stat
          accent={BRAND.blue}
          icon={<MousePointerClick size={15} />}
          title={`${tracking.clicks} link click${tracking.clicks === 1 ? '' : 's'}`}
          lines={urls.map((u) => u)}
          linkLines
        />
      )}
    </div>
  );
}

function Stat({ accent, icon, title, lines, linkLines }) {
  return (
    <div style={{ flex: '1 1 200px', minWidth: 0, padding: '10px 12px', border: '1px solid ' + BRAND.border, borderRadius: 8, background: 'white' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 12.5, color: accent }}>
        {icon}{title}
      </div>
      {lines.map((l, i) => (
        <div key={i} style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
          {linkLines && <ArrowUpRight size={11} style={{ flexShrink: 0 }} />}{l}
        </div>
      ))}
    </div>
  );
}

const OVERLAY = {
  position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(15,42,61,0.45)',
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px 16px',
};
const PANEL = {
  width: 'min(680px, 100%)', maxHeight: '88vh', display: 'flex', flexDirection: 'column',
  background: 'white', borderRadius: 14, boxShadow: '0 24px 64px rgba(15,42,61,0.32)', overflow: 'hidden',
};
const HEADER = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  padding: '14px 16px', borderBottom: '1px solid ' + BRAND.border,
};
const SCROLL = { padding: 16, overflowY: 'auto' };
const CENTER = { padding: '40px 16px', textAlign: 'center', fontSize: 13, color: BRAND.ink };
