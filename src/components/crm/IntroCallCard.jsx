import React, { useEffect, useState } from 'react';
import { CalendarClock, Copy, Check, RefreshCw, Video, AlertTriangle } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { Card, Empty } from './Card.jsx';

// Deal-page "Intro call" card: a PM generates an unguessable booking link to
// paste into a client email, and sees who (if anyone) on the team still needs
// to connect Google Calendar plus any upcoming booked calls.
export function IntroCallCard({ dealId }) {
  const { state, actions } = useStore();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = () => {
    setLoading(true);
    return actions.loadIntroCall(dealId).then((s) => {
      setStatus(s && !s.error ? s : null);
      setLoading(false);
    });
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dealId]);

  const generate = () => {
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
  const bookings = (status?.bookings || []).filter(b => b.status === 'confirmed');
  const upcoming = bookings.filter(b => new Date(b.endsAt).getTime() > Date.now());

  return (
    <Card
      title="Intro call"
      action={link ? (
        <button onClick={regenerate} disabled={busy} className="btn-ghost" title="Generate a fresh link">
          <RefreshCw size={12} /> New link
        </button>
      ) : null}
    >
      {loading ? (
        <Empty text="Loading…" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: BRAND.muted }}>
            Share a booking link so the client can pick a time for an intro call. The call lands on the
            team's Google Calendar with a Meet link.
          </p>

          {blocked.length > 0 && (
            <div style={{ display: 'flex', gap: 8, padding: 10, background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, fontSize: 12, color: '#9A3412' }}>
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
              {blocked.length === 0 && (
                <div style={{ fontSize: 12, color: BRAND.muted }}>
                  {status.slotsAvailable > 0
                    ? `${status.slotsAvailable} slot${status.slotsAvailable === 1 ? '' : 's'} available over the next two weeks.`
                    : 'No slots are currently available — check the team’s working hours and calendars.'}
                </div>
              )}
            </>
          ) : (
            <button onClick={generate} disabled={busy} className="btn" style={{ alignSelf: 'flex-start' }}>
              <CalendarClock size={16} /> {busy ? 'Generating…' : 'Generate Intro Call link'}
            </button>
          )}

          {upcoming.length > 0 && (
            <div style={{ borderTop: '1px solid ' + BRAND.border, paddingTop: 10 }}>
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
    </Card>
  );
}
