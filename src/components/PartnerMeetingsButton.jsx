import React, { useEffect, useState } from 'react';
import { CalendarClock, Copy, Check, RefreshCw, Video, AlertTriangle, X } from 'lucide-react';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { Modal } from './ui.jsx';

// "Meetings" button for a partner/credits client (no deal team). Opens a modal
// where the team member picks who hosts the call — defaulting to themselves —
// then generates a shareable booking link and shows availability + upcoming
// calls. Booked calls land on the chosen hosts' Google Calendars.
export function PartnerMeetingsButton({ clientKey, clientName, primary = false }) {
  const { state, actions } = useStore();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(null);
  const [hosts, setHosts] = useState([]);      // selected host emails
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const sessionEmail = (state.session?.email || '').toLowerCase();
  const users = Object.entries(state.users || {})
    .map(([email, u]) => ({ email: email.toLowerCase(), name: u.name || email }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const load = (compute) => actions.loadPartnerIntroCall(clientKey, compute).then((s) => {
    const ok = s && !s.error ? s : null;
    setStatus(ok);
    return ok;
  });

  const openModal = () => {
    setOpen(true);
    setRevealed(false);
    setStatus(null);
    load().then((s) => {
      // Prefill the host selection from an existing link, else just me.
      const existing = s?.link?.hostEmails;
      setHosts(existing && existing.length ? existing.map((e) => e.toLowerCase()) : (sessionEmail ? [sessionEmail] : []));
      if (s?.link) setRevealed(true);
    });
  };

  const toggleHost = (email) => {
    setHosts((hs) => (hs.includes(email) ? hs.filter((e) => e !== email) : [...hs, email]));
  };

  // Save the chosen hosts + (re)generate the link, then reveal availability.
  const generate = () => {
    if (!hosts.length) return;
    setBusy(true);
    actions.savePartnerIntroCallLink(clientKey, clientName, hosts)
      .then(() => load(true))
      .then(() => setRevealed(true))
      .finally(() => setBusy(false));
  };

  const refreshAvailability = () => { setBusy(true); load(true).finally(() => setBusy(false)); };

  const cancelBooking = (b) => {
    if (!window.confirm(`Cancel the meeting with ${b.clientName}? They'll be notified by Google.`)) return;
    setBusy(true);
    actions.cancelPartnerIntroCallBooking(b.id).then(() => load()).finally(() => setBusy(false));
  };

  const copy = (url) => {
    navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); });
  };

  const nameFor = (email) => state.users?.[email]?.name || email;
  const link = status?.link || null;
  const blocked = status?.blocked || [];
  const upcoming = (status?.bookings || []).filter((b) => b.status === 'confirmed' && new Date(b.endsAt).getTime() > Date.now());

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); openModal(); }}
        className={primary ? 'btn' : 'btn-ghost'}
        style={primary ? undefined : { fontSize: 12, padding: '4px 10px' }}
        title="Generate a booking link for this client"
      >
        <CalendarClock size={14} /> Meetings
      </button>

      {open && (
        <Modal onClose={() => setOpen(false)} maxWidth={460} showClose={false}>
          <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Meetings — {clientName}</h2>
              <button onClick={() => setOpen(false)} className="btn-icon" aria-label="Close"><X size={16} /></button>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: BRAND.muted }}>
              Pick who hosts the call, then share the link. The client books a time when everyone's free and it lands on their Google Calendars with a Meet link.
            </p>

            {/* Host picker */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Hosts</div>
              <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid ' + BRAND.border, borderRadius: 8 }}>
                {users.map((u) => (
                  <label key={u.email} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid ' + BRAND.border }}>
                    <input type="checkbox" checked={hosts.includes(u.email)} onChange={() => toggleHost(u.email)} />
                    {u.name}{u.email === sessionEmail ? ' (me)' : ''}
                  </label>
                ))}
              </div>
            </div>

            {revealed && blocked.length > 0 && (
              <div style={{ display: 'flex', gap: 8, padding: 10, background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, fontSize: 12, color: '#9A3412' }}>
                <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                <div>
                  Booking is paused until everyone connects Google Calendar:
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {blocked.map((b) => (
                      <li key={b.email || 'team'}>
                        {b.email ? nameFor(b.email) : 'No host selected'}
                        {b.reason === 'needs_calendar' ? ' — needs to reconnect for Calendar' :
                          b.reason === 'not_connected' ? ' — hasn’t connected Google' : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {revealed && link ? (
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
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 12, color: BRAND.muted }}>
                    {status.slotsAvailable == null ? '—'
                      : status.slotsAvailable > 0
                        ? `${status.slotsAvailable} slot${status.slotsAvailable === 1 ? '' : 's'} available over the next two weeks.`
                        : 'No slots currently available — check working hours & calendars.'}
                  </span>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button onClick={generate} disabled={busy || !hosts.length} className="btn-ghost" style={{ fontSize: 12 }} title="Update hosts / regenerate">
                      <RefreshCw size={12} /> Update
                    </button>
                    <button onClick={refreshAvailability} disabled={busy} className="btn-ghost" style={{ fontSize: 12 }} aria-label="Refresh availability" title="Re-check availability">
                      <RefreshCw size={12} />
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <button onClick={generate} disabled={busy || !hosts.length} className="btn" style={{ alignSelf: 'flex-start' }}>
                <CalendarClock size={14} /> {busy ? 'Preparing…' : 'Generate booking link'}
              </button>
            )}

            {upcoming.length > 0 && (
              <div style={{ borderTop: '1px solid ' + BRAND.border, paddingTop: 12 }}>
                <div style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 6 }}>Upcoming calls</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {upcoming.map((b) => (
                    <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                      <Video size={14} color={BRAND.blue} style={{ flexShrink: 0 }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 500 }}>{b.clientName}</div>
                        <div style={{ color: BRAND.muted, fontSize: 12 }}>{new Date(b.startsAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</div>
                      </div>
                      {b.meetUrl && <a href={b.meetUrl} target="_blank" rel="noreferrer" style={{ color: BRAND.blue, flexShrink: 0 }}>Join</a>}
                      <button onClick={() => cancelBooking(b)} disabled={busy} title="Cancel this meeting" style={{ flexShrink: 0, background: 'none', border: 'none', color: '#DC2626', cursor: 'pointer', padding: 2, display: 'flex' }}><X size={14} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
