import React, { useEffect, useRef, useState } from 'react';
import { CalendarClock, Copy, Check, RefreshCw, Video, AlertTriangle } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';

// Header button + popover for the deal/project page. Generates an unguessable
// booking link a PM can share with a client, and shows who (if anyone) still
// needs to connect Google Calendar plus any upcoming booked calls. Kept compact
// (no full-width section) since it's secondary to the rest of the page.
export function IntroCallButton({ dealId }) {
  const { state, actions } = useStore();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const load = () => actions.loadIntroCall(dealId).then((s) => setStatus(s && !s.error ? s : null));

  // Clicking the button opens the popover and ensures a link exists (the POST is
  // idempotent — it returns the existing active link if there is one).
  const onClick = () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    setBusy(true);
    actions.generateIntroCallLink(dealId)
      .then(() => load())
      .finally(() => setBusy(false));
  };

  const regenerate = () => {
    if (!window.confirm('Generate a new link? The current link will stop working.')) return;
    setBusy(true);
    actions.revokeIntroCallLink(dealId)
      .then(() => actions.generateIntroCallLink(dealId))
      .then(() => load())
      .finally(() => setBusy(false));
  };

  const copy = (url) => {
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  const nameFor = (email) => state.users?.[email]?.name || email;
  const blocked = status?.blocked || [];
  const link = status?.link || null;
  const upcoming = (status?.bookings || []).filter(b => b.status === 'confirmed' && new Date(b.endsAt).getTime() > Date.now());

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button onClick={onClick} className="btn"><CalendarClock size={14} /> Generate Call Link</button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 50,
          width: 'min(380px, calc(100vw - 32px))',
          background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10,
          boxShadow: '0 8px 28px rgba(15,42,61,0.14)', padding: 16,
        }}>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: BRAND.muted }}>
            Share this link so the client can pick a time. The call lands on the team's Google
            Calendar with a Meet link.
          </p>

          {blocked.length > 0 && (
            <div style={{ display: 'flex', gap: 8, padding: 10, marginBottom: 12, background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, fontSize: 12, color: '#9A3412' }}>
              <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>
                Booking is paused until everyone connects Google Calendar:
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {blocked.map(b => (
                    <li key={b.email || 'team'}>
                      {b.email ? nameFor(b.email) : 'No producer assigned'}
                      {b.reason === 'needs_calendar' ? ' — needs to reconnect for Calendar' :
                        b.reason === 'not_connected' ? ' — hasn’t connected Google' :
                        b.reason === 'no_team' ? '' : ' — needs attention'}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {link ? (
            <>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  readOnly
                  value={link.url}
                  onFocus={(e) => e.target.select()}
                  style={{ flex: 1, minWidth: 0, padding: '8px 10px', border: '1px solid ' + BRAND.border, borderRadius: 6, fontSize: 12, color: BRAND.ink, background: '#F8FAFC', fontFamily: 'inherit' }}
                />
                <button onClick={() => copy(link.url)} className="btn" style={{ flexShrink: 0 }}>
                  {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 8 }}>
                {blocked.length === 0 ? (
                  <span style={{ fontSize: 12, color: BRAND.muted }}>
                    {status.slotsAvailable > 0
                      ? `${status.slotsAvailable} slot${status.slotsAvailable === 1 ? '' : 's'} available over the next two weeks.`
                      : 'No slots currently available — check working hours & calendars.'}
                  </span>
                ) : <span />}
                <button onClick={regenerate} disabled={busy} className="btn-ghost" style={{ flexShrink: 0, fontSize: 12 }} title="Generate a fresh link">
                  <RefreshCw size={12} /> New link
                </button>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 13, color: BRAND.muted }}>{busy ? 'Generating link…' : 'Loading…'}</div>
          )}

          {upcoming.length > 0 && (
            <div style={{ borderTop: '1px solid ' + BRAND.border, paddingTop: 10, marginTop: 12 }}>
              <div style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 6 }}>
                Upcoming calls
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {upcoming.map(b => (
                  <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                    <Video size={14} color={BRAND.blue} style={{ flexShrink: 0 }} />
                    <span style={{ fontWeight: 500 }}>{b.clientName}</span>
                    <span style={{ color: BRAND.muted }}>
                      {new Date(b.startsAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                    </span>
                    {b.meetUrl && (
                      <a href={b.meetUrl} target="_blank" rel="noreferrer" style={{ color: BRAND.blue, marginLeft: 'auto' }}>Join</a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
