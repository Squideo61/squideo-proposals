import React, { useEffect, useRef, useState } from 'react';
import { CalendarClock, Copy, Check, RefreshCw, Video, AlertTriangle, X, Rocket, Users } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';

// ISO (UTC) → value for a <input type="datetime-local"> in the PM's local time.
function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The kick-off call sub-panel. The client books from their portal; here the PM
// can pre-agree a specific time (or leave it open for the client to pick).
function KickoffSection({ dealId }) {
  const { actions } = useStore();
  const [data, setData] = useState(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = () => actions.loadKickoffCall(dealId).then((d) => {
    if (d && !d.error) { setData(d); setValue(isoToLocalInput(d.proposedStartsAt)); }
  });
  useEffect(() => { load(); }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (proposedIso) => {
    setBusy(true);
    actions.setKickoffProposal(dealId, proposedIso)
      .then(() => { setSaved(true); setTimeout(() => setSaved(false), 1600); return load(); })
      .finally(() => setBusy(false));
  };

  const booked = (data?.bookings || []).find((b) => b.status === 'confirmed' && new Date(b.endsAt).getTime() > Date.now());

  return (
    <div style={{ borderTop: '1px solid ' + BRAND.border, paddingTop: 12, marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 8 }}>
        <Rocket size={13} /> Kick-off call
      </div>
      {booked ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <Check size={14} color="#16A34A" style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500 }}>Booked by {booked.clientName}</div>
            <div style={{ color: BRAND.muted, fontSize: 12 }}>{new Date(booked.startsAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</div>
          </div>
          {booked.meetUrl && <a href={booked.meetUrl} target="_blank" rel="noreferrer" style={{ color: BRAND.blue, flexShrink: 0 }}>Join</a>}
        </div>
      ) : (
        <>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: BRAND.muted }}>
            The client books this from their portal. Propose a time if you've already agreed one — otherwise leave it blank and they'll pick from your team's availability.
          </p>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="datetime-local"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              style={{ flex: 1, minWidth: 170, padding: '7px 9px', border: '1px solid ' + BRAND.border, borderRadius: 6, fontSize: 12.5, fontFamily: 'inherit' }}
            />
            <button onClick={() => save(value ? new Date(value).toISOString() : null)} disabled={busy} className="btn" style={{ flexShrink: 0 }}>
              {saved ? <><Check size={14} /> Saved</> : 'Propose'}
            </button>
          </div>
          {data?.proposedStartsAt && (
            <button onClick={() => { setValue(''); save(null); }} disabled={busy} className="btn-ghost" style={{ fontSize: 12, marginTop: 6 }}>
              Clear proposed time
            </button>
          )}
        </>
      )}
    </div>
  );
}

// Header button + popover for the deal/project page. Generates an unguessable
// booking link a PM can share with a client, and shows who (if anyone) still
// needs to connect Google Calendar plus any upcoming booked calls. Kept compact
// (no full-width section) since it's secondary to the rest of the page.

// One upcoming call: when it is, who from our side is on it, and a way to add
// someone who isn't. Guests go on as OPTIONAL — the required attendee list is
// what future slots get checked against, so a late addition mustn't
// retroactively narrow what anyone else can book.
function BookingRow({ booking, busy, nameFor, teamEmails, onAdd, onCancel }) {
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const on = booking.attendees || [];
  // Colleagues not already on the call — picking one of these is the common
  // case, not typing an address out.
  const missing = (teamEmails || []).filter((e) => !on.includes(String(e).toLowerCase()));

  const submit = (value) => {
    const clean = String(value || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) { setError('Enter a valid email address'); return; }
    setError(null);
    Promise.resolve(onAdd(clean)).then(() => { setAdding(false); setEmail(''); });
  };

  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Video size={14} color={BRAND.blue} style={{ flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{booking.clientName}</div>
          <div style={{ color: BRAND.muted, fontSize: 12 }}>
            {new Date(booking.startsAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
          </div>
        </div>
        {booking.meetUrl && (
          <a href={booking.meetUrl} target="_blank" rel="noreferrer" style={{ color: BRAND.blue, flexShrink: 0 }}>Join</a>
        )}
        <button
          onClick={onCancel}
          disabled={busy}
          title="Cancel this meeting"
          style={{ flexShrink: 0, background: 'none', border: 'none', color: '#DC2626', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, padding: 2, display: 'flex', alignItems: 'center' }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Who is on it. Worth stating plainly — "only Hannah got added" isn't
          something anyone should have to discover from their own calendar. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', margin: '4px 0 0 22px', fontSize: 11.5, color: BRAND.muted }}>
        <Users size={12} style={{ flexShrink: 0 }} />
        <span>{on.length ? on.map(nameFor).join(', ') : 'nobody from Squideo'}</span>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            disabled={busy}
            style={{ background: 'none', border: 'none', color: BRAND.blue, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, padding: 0 }}
          >
            + Add someone
          </button>
        )}
      </div>

      {adding && (
        <div style={{ margin: '6px 0 0 22px', display: 'flex', flexDirection: 'column', gap: 5 }}>
          {missing.length > 0 && (
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {missing.slice(0, 6).map((e) => (
                <button
                  key={e}
                  onClick={() => submit(e)}
                  disabled={busy}
                  style={{ background: '#F1F4F7', border: '1px solid ' + BRAND.border, borderRadius: 999, padding: '3px 10px', fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit', color: BRAND.ink }}
                >
                  {nameFor(e)}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="input"
              value={email}
              autoFocus
              placeholder="or type an email address"
              onChange={(ev) => setEmail(ev.target.value)}
              onKeyDown={(ev) => { if (ev.key === 'Enter') submit(email); }}
              style={{ flex: 1, fontSize: 12, padding: '5px 8px' }}
            />
            <button className="btn" disabled={busy} onClick={() => submit(email)} style={{ fontSize: 12, padding: '5px 10px' }}>
              {busy ? 'Adding…' : 'Add'}
            </button>
            <button
              onClick={() => { setAdding(false); setError(null); setEmail(''); }}
              style={{ background: 'none', border: 'none', color: BRAND.muted, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}
            >
              Cancel
            </button>
          </div>
          <div style={{ fontSize: 11, color: error ? '#DC2626' : BRAND.muted }}>
            {error || 'They get a Google invite straight away, as an optional guest.'}
          </div>
        </div>
      )}
    </div>
  );
}

export function IntroCallButton({ dealId }) {
  const { state, actions } = useStore();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(null);
  const [revealed, setRevealed] = useState(false); // link + availability shown after "New Meeting"
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

  // Cheap load (no Google compute): just the link + bookings. `compute` re-runs
  // the availability check (one Google call per attendee) on demand.
  const load = (compute) => actions.loadIntroCall(dealId, compute).then((s) => setStatus(s && !s.error ? s : null));

  // Clicking the button just opens the popover and does a CHEAP load — it does
  // NOT create a link or hit Google. We show only the "New Meeting" button (plus
  // any upcoming meetings) until the user explicitly acts.
  const onClick = () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    setStatus(null);
    setRevealed(false);
    load();
  };

  // "New Meeting" — ensure the shareable link exists (idempotent) and run the
  // availability check, then reveal the link + slot count. This is the only
  // place the expensive Google compute happens.
  const newMeeting = () => {
    setBusy(true);
    actions.generateIntroCallLink(dealId)
      .then(() => load(true))
      .then(() => setRevealed(true))
      .finally(() => setBusy(false));
  };

  // Re-check availability after it's been revealed.
  const refreshAvailability = () => {
    setBusy(true);
    load(true).finally(() => setBusy(false));
  };

  const cancelBooking = (booking) => {
    if (!window.confirm(`Cancel the meeting with ${booking.clientName}? They'll be notified by Google.`)) return;
    setBusy(true);
    actions.cancelIntroCallBooking(dealId, booking.id)
      .then(() => load())
      .finally(() => setBusy(false));
  };

  // Add someone to a call that's already booked. The team on a deal changes
  // after the client picks a time, and until now the only way to reflect that
  // was editing the Google event by hand — which left our own record of who's
  // on the call, and the day-of reminder built from it, quietly wrong.
  const addAttendee = (booking, email) => {
    setBusy(true);
    return actions.addIntroCallAttendee(dealId, booking.id, email)
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
      <button onClick={onClick} className="btn"><CalendarClock size={14} /> Meetings</button>

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

          {revealed && blocked.length > 0 && (
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

          {status === null ? (
            <div style={{ fontSize: 13, color: BRAND.muted }}>Loading…</div>
          ) : revealed && link ? (
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
                <span style={{ fontSize: 12, color: BRAND.muted }}>
                  {status.slotsAvailable == null
                    ? '—'
                    : status.slotsAvailable > 0
                      ? `${status.slotsAvailable} slot${status.slotsAvailable === 1 ? '' : 's'} available over the next two weeks.`
                      : 'No slots currently available — check working hours & calendars.'}
                </span>
                <button onClick={refreshAvailability} disabled={busy} className="btn-ghost" style={{ fontSize: 12, flexShrink: 0 }} title="Re-check availability" aria-label="Refresh availability">
                  <RefreshCw size={12} />
                </button>
              </div>
            </>
          ) : (
            <button onClick={newMeeting} disabled={busy} className="btn" style={{ alignSelf: 'flex-start' }}>
              <CalendarClock size={14} /> {busy ? 'Preparing…' : 'New Meeting'}
            </button>
          )}

          <KickoffSection dealId={dealId} />

          {upcoming.length > 0 && (
            <div style={{ borderTop: '1px solid ' + BRAND.border, paddingTop: 10, marginTop: 12 }}>
              <div style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 6 }}>
                Upcoming calls
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {upcoming.map(b => (
                  <BookingRow
                    key={b.id}
                    booking={b}
                    busy={busy}
                    nameFor={nameFor}
                    teamEmails={Object.keys(state.users || {})}
                    onAdd={(email) => addAttendee(b, email)}
                    onCancel={() => cancelBooking(b)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
