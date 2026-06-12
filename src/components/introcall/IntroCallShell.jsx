import React, { useEffect, useMemo, useState } from 'react';
import { BRAND } from '../../theme.js';

// Public, unauthenticated booking page (/?introCall=<token>). Self-contained:
// fetches free slots, lets the client pick a time and enter their details, then
// books — creating a Google Calendar event with a Meet link server-side. No
// store/session dependency since clients open this with no account.
export function IntroCallShell({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);
  const [confirmed, setConfirmed] = useState(null);

  const reload = () => {
    fetch('/api/intro-call/public?token=' + encodeURIComponent(token))
      .then(async (r) => {
        if (!r.ok) throw new Error('dead');
        return r.json();
      })
      .then((d) => setData(d))
      .catch(() => setError(true));
  };

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [token]);

  const days = useMemo(() => groupByDay(data?.slots || []), [data]);

  if (error) return <Centered>This booking link is no longer active.</Centered>;
  if (!data) return <Centered>Loading…</Centered>;

  if (confirmed) {
    return (
      <Centered>
        <div style={{ textAlign: 'center', maxWidth: 460 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
          <h2 style={{ margin: '0 0 8px', fontSize: 20, color: BRAND.ink }}>You're booked in</h2>
          <p style={{ margin: '0 0 6px', color: BRAND.ink }}>
            {new Date(confirmed.start).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })}
          </p>
          <p style={{ margin: '0 0 16px', color: BRAND.muted, fontSize: 14 }}>
            A calendar invite is on its way to {email}.
          </p>
          {confirmed.meetUrl && (
            <a href={confirmed.meetUrl} target="_blank" rel="noreferrer" style={btnStyle}>Join Google Meet</a>
          )}
        </div>
      </Centered>
    );
  }

  const submit = () => {
    setFormError(null);
    if (!name.trim()) { setFormError('Please enter your name.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setFormError('Please enter a valid email.'); return; }
    if (!selected) { setFormError('Please choose a time.'); return; }
    setSubmitting(true);
    fetch('/api/intro-call/book?token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), email: email.trim(), start: selected }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          // A taken slot returns fresh availability — refresh the grid.
          if (body.slots) { setData((d) => ({ ...d, slots: body.slots })); setSelected(null); }
          throw new Error(body.error || 'Could not book that time.');
        }
        return body;
      })
      .then((body) => setConfirmed(body))
      .catch((e) => setFormError(e.message))
      .finally(() => setSubmitting(false));
  };

  return (
    <div style={{ minHeight: '100vh', background: BRAND.paper, color: BRAND.ink, padding: '32px 16px' }}>
      <div style={{ maxWidth: 620, margin: '0 auto' }}>
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 14, overflow: 'hidden' }}>
          <div style={{ padding: '24px 28px', borderBottom: '1px solid ' + BRAND.border }}>
            <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6, color: BRAND.muted, fontWeight: 700 }}>Book an intro call</div>
            <h1 style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 700 }}>{data.projectName}</h1>
            <p style={{ margin: '8px 0 0', fontSize: 14, color: BRAND.muted }}>
              {data.durationMinutes}-minute video call · times shown in UK time
            </p>
          </div>

          {!data.ready ? (
            <div style={{ padding: 28, color: BRAND.muted }}>
              Booking isn't available just yet — the team is finishing setup. Please check back shortly.
            </div>
          ) : days.length === 0 ? (
            <div style={{ padding: 28, color: BRAND.muted }}>
              No times are currently available. Please check back soon or reply to the email that brought you here.
            </div>
          ) : (
            <div style={{ padding: 28 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                {days.map((day) => (
                  <div key={day.key}>
                    <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{day.label}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {day.slots.map((s) => {
                        const isSel = selected === s.start;
                        return (
                          <button
                            key={s.start}
                            onClick={() => setSelected(s.start)}
                            style={{
                              padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', fontSize: 14,
                              border: '1px solid ' + (isSel ? BRAND.blue : BRAND.border),
                              background: isSel ? BRAND.blue : 'white',
                              color: isSel ? 'white' : BRAND.ink, fontWeight: isSel ? 600 : 400,
                            }}
                          >
                            {new Date(s.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 24, borderTop: '1px solid ' + BRAND.border, paddingTop: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <input
                    placeholder="Your name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    style={inputStyle}
                  />
                  <input
                    placeholder="Your email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    style={inputStyle}
                  />
                </div>
                {formError && <div style={{ color: '#DC2626', fontSize: 13 }}>{formError}</div>}
                <button onClick={submit} disabled={submitting || !selected} style={{ ...btnStyle, opacity: (submitting || !selected) ? 0.6 : 1, border: 'none', cursor: (submitting || !selected) ? 'default' : 'pointer' }}>
                  {submitting ? 'Booking…' : selected
                    ? `Confirm ${new Date(selected).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                    : 'Select a time above'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function groupByDay(slots) {
  const map = new Map();
  for (const s of slots) {
    const d = new Date(s.start);
    const key = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    if (!map.has(key)) map.set(key, { key, label: d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }), slots: [] });
    map.get(key).slots.push(s);
  }
  return Array.from(map.values());
}

const inputStyle = {
  flex: '1 1 200px', minWidth: 0, padding: '10px 12px', borderRadius: 8,
  border: '1px solid ' + BRAND.border, fontSize: 14, fontFamily: 'inherit',
};

const btnStyle = {
  display: 'inline-block', background: BRAND.blue, color: 'white', textDecoration: 'none',
  padding: '12px 18px', borderRadius: 8, fontWeight: 600, fontSize: 15, textAlign: 'center',
};

function Centered({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: BRAND.paper, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ fontSize: 14, color: BRAND.muted }}>{children}</div>
    </div>
  );
}
