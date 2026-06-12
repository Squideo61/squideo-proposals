import React, { useEffect, useMemo, useState } from 'react';
import { Clock, Video, ChevronLeft, ChevronRight } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { Logo } from '../ui.jsx';

// Public, unauthenticated booking page (/?introCall=<token>), mirroring Google
// Calendar's appointment-scheduling layout: host on the left, a week-column
// time grid with a mini-month calendar, and a Google-style modal on slot click.
// Self-contained (plain fetch) — clients open this with no account/session.
export function IntroCallShell({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [weekStart, setWeekStart] = useState(null);   // local Monday of the shown week
  const [calMonth, setCalMonth] = useState(null);     // first-of-month shown in mini calendar
  const [modalSlot, setModalSlot] = useState(null);
  const [confirmed, setConfirmed] = useState(null);

  const load = () => {
    fetch('/api/intro-call/public?token=' + encodeURIComponent(token))
      .then(async (r) => { if (!r.ok) throw new Error('dead'); return r.json(); })
      .then((d) => {
        setData(d);
        const first = (d.slots && d.slots[0]) ? new Date(d.slots[0].start) : new Date();
        setWeekStart((ws) => ws || mondayOf(first));
        setCalMonth((cm) => cm || firstOfMonth(first));
      })
      .catch(() => setError(true));
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [token]);

  const slotsByDay = useMemo(() => {
    const m = new Map();
    for (const s of (data?.slots || [])) {
      const key = dayKey(new Date(s.start));
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(s);
    }
    return m;
  }, [data]);

  const lastSlotDate = useMemo(() => {
    const slots = data?.slots || [];
    return slots.length ? new Date(slots[slots.length - 1].start) : null;
  }, [data]);

  if (error) return <Centered>This booking link is no longer active.</Centered>;
  if (!data) return <Centered>Loading…</Centered>;

  if (confirmed) {
    return (
      <Centered>
        <div style={{ textAlign: 'center', maxWidth: 460 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
          <h2 style={{ margin: '0 0 8px', fontSize: 20, color: BRAND.ink }}>Thanks for booking</h2>
          <p style={{ margin: '0 0 6px', color: BRAND.ink }}>
            {new Date(confirmed.start).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })}
          </p>
          <p style={{ margin: 0, color: BRAND.muted, fontSize: 14, lineHeight: 1.5 }}>
            Please check your email for a calendar invite. Accept the invite to finalise your booking.
          </p>
        </div>
      </Centered>
    );
  }

  const weekDays = weekStart ? Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)) : [];
  const canPrev = weekStart && mondayOf(new Date()) < weekStart;
  const canNext = weekStart && lastSlotDate && addDays(weekStart, 7) <= lastSlotDate;
  const tzLabel = browserTzLabel();

  return (
    <div style={{ minHeight: '100vh', background: 'white', color: BRAND.ink, padding: '28px 24px' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        {/* Header: Squideo branding on the left, meeting info on the right.
            We deliberately don't name the assigned host — the team can change. */}
        <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap', marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', minWidth: 200 }}>
            <Logo size={32} />
          </div>
          <div style={{ flex: 1, minWidth: 260 }}>
            <h1 style={{ margin: '0 0 14px', fontSize: 22, fontWeight: 500 }}>{data.projectName}</h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: BRAND.ink, fontSize: 14, marginBottom: 8 }}>
              <Clock size={18} color={BRAND.muted} /> {data.durationMinutes} min appointments
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: BRAND.ink, fontSize: 14 }}>
              <Video size={18} color={BRAND.muted} /> Google Meet video conference info added after booking
            </div>
          </div>
        </div>

        {!data.ready ? (
          <Panel>Booking isn't available just yet — the team is finishing setup. Please check back shortly.</Panel>
        ) : (data.slots || []).length === 0 ? (
          <Panel>No times are currently available. Please check back soon or reply to the email that brought you here.</Panel>
        ) : (
          <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500 }}>Select an appointment time</h2>
              <div style={{ fontSize: 13, color: BRAND.muted }}>{tzLabel}</div>
            </div>

            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              {/* Mini month calendar */}
              <MiniCalendar
                calMonth={calMonth}
                setCalMonth={setCalMonth}
                slotsByDay={slotsByDay}
                selectedWeek={weekStart}
                onPickDay={(d) => { setWeekStart(mondayOf(d)); }}
              />

              {/* Week columns */}
              <div style={{ flex: 1, minWidth: 320 }}>
                <div style={{ display: 'flex', alignItems: 'stretch', gap: 6 }}>
                  <NavArrow dir="prev" disabled={!canPrev} onClick={() => canPrev && setWeekStart(addDays(weekStart, -7))} />
                  <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
                    {weekDays.map((d) => {
                      const slots = slotsByDay.get(dayKey(d)) || [];
                      return (
                        <div key={dayKey(d)} style={{ minWidth: 0 }}>
                          <div style={{ textAlign: 'center', marginBottom: 10 }}>
                            <div style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                              {d.toLocaleDateString('en-GB', { weekday: 'short' })}
                            </div>
                            <div style={{ fontSize: 20, fontWeight: 500, marginTop: 2, color: isSameDay(d, new Date()) ? 'white' : BRAND.ink,
                              ...(isSameDay(d, new Date()) ? { background: BRAND.blue, borderRadius: '50%', width: 34, height: 34, lineHeight: '34px', margin: '2px auto 0' } : {}) }}>
                              {d.getDate()}
                            </div>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
                            {slots.length === 0
                              ? <div style={{ color: BRAND.muted }}>—</div>
                              : slots.map((s) => (
                                <button
                                  key={s.start}
                                  onClick={() => setModalSlot(s)}
                                  style={slotBtn}
                                  onMouseEnter={(e) => { e.currentTarget.style.background = '#EFF8FE'; e.currentTarget.style.borderColor = BRAND.blue; }}
                                  onMouseLeave={(e) => { e.currentTarget.style.background = 'white'; e.currentTarget.style.borderColor = '#C7D2DC'; }}
                                >
                                  {new Date(s.start).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase().replace(' ', '')}
                                </button>
                              ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <NavArrow dir="next" disabled={!canNext} onClick={() => canNext && setWeekStart(addDays(weekStart, 7))} />
                </div>
              </div>
            </div>
          </div>
        )}

        <div style={{ textAlign: 'center', marginTop: 20, fontSize: 12, color: BRAND.muted }}>
          Powered by Squideo
        </div>
      </div>

      {modalSlot && (
        <BookingModal
          token={token}
          slot={modalSlot}
          data={data}
          onClose={() => setModalSlot(null)}
          onBooked={(body) => { setModalSlot(null); setConfirmed(body); }}
          onSlotTaken={(slots) => { setData((d) => ({ ...d, slots })); setModalSlot(null); }}
        />
      )}
    </div>
  );
}

function BookingModal({ token, slot, data, onClose, onBooked, onSlotTaken }) {
  const [firstName, setFirstName] = useState('');
  const [surname, setSurname] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const start = new Date(slot.start);
  const end = new Date(slot.end);

  const submit = () => {
    setError(null);
    if (!firstName.trim()) { setError('Please enter your first name.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('Please enter a valid email.'); return; }
    setSubmitting(true);
    fetch('/api/intro-call/book?token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${firstName.trim()} ${surname.trim()}`.trim(),
        email: email.trim(),
        start: slot.start,
      }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          if (body.slots) { onSlotTaken(body.slots); }
          throw new Error(body.error || 'Could not book that time.');
        }
        return body;
      })
      .then((body) => onBooked(body))
      .catch((e) => setError(e.message))
      .finally(() => setSubmitting(false));
  };

  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,42,61,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 100 }}>
      <div onMouseDown={(e) => e.stopPropagation()} style={{ background: 'white', borderRadius: 16, width: 'min(440px, 100%)', maxHeight: '90vh', overflowY: 'auto', padding: 28, boxShadow: '0 12px 40px rgba(0,0,0,0.25)' }}>
        <h2 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 500 }}>{data.projectName}</h2>
        <div style={{ fontSize: 14, color: BRAND.ink }}>
          {start.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} · {start.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true })} – {end.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true })}
        </div>
        <div style={{ fontSize: 13, color: BRAND.muted, marginTop: 2 }}>{browserTzLabel()}</div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: BRAND.ink, margin: '16px 0', paddingBottom: 16, borderBottom: '1px solid ' + BRAND.border }}>
          <Video size={18} color={BRAND.muted} /> Google Meet video conference info added after booking
        </div>

        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Your contact info</div>
        <Labeled label="First name"><input value={firstName} onChange={(e) => setFirstName(e.target.value)} style={modalInput} autoFocus /></Labeled>
        <Labeled label="Surname"><input value={surname} onChange={(e) => setSurname(e.target.value)} style={modalInput} /></Labeled>
        <Labeled label="Email address"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={modalInput} /></Labeled>

        {error && <div style={{ color: '#DC2626', fontSize: 13, marginTop: 4 }}>{error}</div>}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 14, marginTop: 20 }}>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: BRAND.blue, fontWeight: 600, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
          <button onClick={submit} disabled={submitting} style={{ ...primaryBtn, padding: '10px 22px', borderRadius: 999, opacity: submitting ? 0.6 : 1, border: 'none', cursor: submitting ? 'default' : 'pointer' }}>
            {submitting ? 'Booking…' : 'Book'}
          </button>
        </div>
      </div>
    </div>
  );
}

function MiniCalendar({ calMonth, setCalMonth, slotsByDay, selectedWeek, onPickDay }) {
  if (!calMonth) return null;
  const year = calMonth.getFullYear();
  const month = calMonth.getMonth();
  const firstDay = new Date(year, month, 1);
  // Grid starts on the Monday on/before the 1st.
  const gridStart = mondayOf(firstDay);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const weekEnd = selectedWeek ? addDays(selectedWeek, 6) : null;

  return (
    <div style={{ width: 240, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 500 }}>{calMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</div>
        <div style={{ display: 'flex', gap: 2 }}>
          <button onClick={() => setCalMonth(new Date(year, month - 1, 1))} style={miniNav} aria-label="Previous month"><ChevronLeft size={16} /></button>
          <button onClick={() => setCalMonth(new Date(year, month + 1, 1))} style={miniNav} aria-label="Next month"><ChevronRight size={16} /></button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, fontSize: 11, color: BRAND.muted, marginBottom: 4 }}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <div key={i} style={{ textAlign: 'center' }}>{d}</div>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {cells.map((d) => {
          const inMonth = d.getMonth() === month;
          const hasSlots = slotsByDay.has(dayKey(d));
          const inSelWeek = selectedWeek && d >= selectedWeek && d <= weekEnd;
          const isPast = d < today;
          return (
            <button
              key={d.toISOString()}
              disabled={!hasSlots}
              onClick={() => hasSlots && onPickDay(d)}
              style={{
                aspectRatio: '1', borderRadius: '50%', border: 'none', fontFamily: 'inherit', fontSize: 13,
                cursor: hasSlots ? 'pointer' : 'default',
                background: inSelWeek && hasSlots ? '#D6ECFB' : hasSlots ? '#EFF8FE' : 'transparent',
                color: !inMonth || isPast ? '#C7D2DC' : hasSlots ? BRAND.blue : BRAND.ink,
                fontWeight: hasSlots ? 600 : 400,
              }}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NavArrow({ dir, disabled, onClick }) {
  const Icon = dir === 'prev' ? ChevronLeft : ChevronRight;
  return (
    <button onClick={onClick} disabled={disabled} aria-label={dir === 'prev' ? 'Previous week' : 'Next week'}
      style={{ alignSelf: 'center', width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'transparent',
        cursor: disabled ? 'default' : 'pointer', color: disabled ? '#D6DEE5' : BRAND.ink, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <Icon size={22} />
    </button>
  );
}

function Labeled({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function Panel({ children }) {
  return <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 28, color: BRAND.muted }}>{children}</div>;
}

function Centered({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ fontSize: 14, color: BRAND.muted }}>{children}</div>
    </div>
  );
}

// ── date helpers (browser-local) ─────────────────────────────────────────────
function mondayOf(date) {
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // 0=Mon
  d.setDate(d.getDate() - day);
  return d;
}
function firstOfMonth(date) { return new Date(date.getFullYear(), date.getMonth(), 1); }
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function dayKey(date) { return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }
function isSameDay(a, b) { return dayKey(a) === dayKey(b); }

function browserTzLabel() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const offMin = -new Date().getTimezoneOffset();
    const sign = offMin >= 0 ? '+' : '-';
    const abs = Math.abs(offMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    return `(GMT${sign}${hh}:${mm}) ${tz.replace(/_/g, ' ')}`;
  } catch { return ''; }
}

// ── styles ───────────────────────────────────────────────────────────────────
const slotBtn = {
  width: '100%', maxWidth: 110, padding: '9px 6px', borderRadius: 8, cursor: 'pointer',
  border: '1px solid #C7D2DC', background: 'white', color: BRAND.blue, fontWeight: 500,
  fontSize: 14, fontFamily: 'inherit', transition: 'background .12s, border-color .12s',
};
const modalInput = {
  width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 6,
  border: '1px solid ' + BRAND.border, fontSize: 14, fontFamily: 'inherit',
};
const miniNav = {
  width: 26, height: 26, borderRadius: '50%', border: 'none', background: 'transparent',
  cursor: 'pointer', color: BRAND.ink, display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const primaryBtn = {
  display: 'inline-block', background: BRAND.blue, color: 'white', textDecoration: 'none',
  padding: '12px 18px', borderRadius: 8, fontWeight: 600, fontSize: 15, textAlign: 'center',
};
