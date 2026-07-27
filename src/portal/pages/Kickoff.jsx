// "Book your kick-off call" — a project task. Reuses the intro-call engine:
// if a producer proposed a specific time we offer "confirm this time",
// otherwise the client picks from the team's live availability. Booking creates
// a Google Meet, just like the sales intro call.
import React, { useEffect, useMemo, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState, SectionHeading } from '../components.jsx';
import { ArrowLeft, CalendarClock, Check, Video, Clock } from 'lucide-react';

const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'Europe/London'; } };

function fmt(dateISO, tz, opts) {
  try { return new Date(dateISO).toLocaleString('en-GB', { timeZone: tz, ...opts }); }
  catch { return new Date(dateISO).toLocaleString('en-GB', opts); }
}

// Group ISO slots by their calendar day in the display timezone.
function groupByDay(slots, tz) {
  const groups = [];
  const index = {};
  for (const s of slots) {
    const dayKey = fmt(s.start, tz, { weekday: 'long', day: 'numeric', month: 'long' });
    if (index[dayKey] === undefined) { index[dayKey] = groups.length; groups.push({ day: dayKey, slots: [] }); }
    groups[index[dayKey]].slots.push(s);
  }
  return groups;
}

export default function Kickoff({ dealId }) {
  const { showToast } = usePortal();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pickMode, setPickMode] = useState(false); // "pick another time" opens the full picker

  const load = async () => {
    try { setData(await portalApi.get(`kickoff?dealId=${encodeURIComponent(dealId)}`)); }
    catch (err) { setError(err.message); }
  };
  useEffect(() => { load(); }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  const tz = data?.timezone || 'Europe/London';
  const days = useMemo(() => groupByDay(data?.slots || [], tz), [data, tz]);

  const bookAt = async (startsAt) => {
    setBusy(true);
    try {
      const res = await portalApi.post('kickoff-book', { dealId, startsAt, timezone: browserTz() });
      setData((d) => ({ ...d, booking: res.booking }));
      showToast('Kick-off call booked 🎉');
    } catch (err) {
      showToast(err.message);
      if (err.status === 409) load(); // slot taken — refresh availability
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div>
        <a href="#/" className="btn-link" style={{ fontSize: 13 }}><ArrowLeft size={14} style={{ verticalAlign: -2 }} /> Back</a>
        <Card style={{ marginTop: 14 }}><EmptyState title="Couldn't load your kick-off call" body={error} /></Card>
      </div>
    );
  }
  if (!data) return <div style={{ color: BRAND.muted, fontSize: 13, padding: 30, textAlign: 'center' }}>Loading…</div>;

  const header = (
    <div>
      <a href={`#/project/${dealId}`} className="btn-link" style={{ fontSize: 13 }}>
        <ArrowLeft size={14} style={{ verticalAlign: -2 }} /> {data.projectName}
      </a>
      <h1 style={{ margin: '8px 0 4px', fontSize: 22, fontWeight: 800, color: BRAND.ink }}>Your kick-off call 📞</h1>
      <p style={{ margin: 0, fontSize: 13.5, color: BRAND.muted, maxWidth: 560, lineHeight: 1.55 }}>
        A quick call to meet the team and get your project moving. We'll send a Google Meet invite once it's booked.
      </p>
    </div>
  );

  // Already booked.
  if (data.booking) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {header}
        <Card>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: '#DCFCE7', color: '#16A34A', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Check size={20} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15.5, fontWeight: 800, color: BRAND.ink, marginBottom: 4 }}>You're all booked in</div>
              <div style={{ fontSize: 13.5, color: BRAND.ink }}>
                {fmt(data.booking.startsAt, tz, { weekday: 'long', day: 'numeric', month: 'long' })}
                {' at '}{fmt(data.booking.startsAt, tz, { hour: '2-digit', minute: '2-digit' })}
              </div>
              <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>The invite is in your inbox and calendar.</div>
              {data.booking.meetUrl && (
                <a href={data.booking.meetUrl} target="_blank" rel="noreferrer" className="btn" style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <Video size={14} /> Join Google Meet
                </a>
              )}
            </div>
          </div>
        </Card>
      </div>
    );
  }

  const showProposed = data.proposedStartsAt && !pickMode;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {header}

      {showProposed ? (
        <Card>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: '#EAF7FC', color: BRAND.blue, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <CalendarClock size={20} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: BRAND.ink, marginBottom: 4 }}>We've proposed a time</div>
              <div style={{ fontSize: 14, color: BRAND.ink }}>
                {fmt(data.proposedStartsAt, tz, { weekday: 'long', day: 'numeric', month: 'long' })}
                {' at '}{fmt(data.proposedStartsAt, tz, { hour: '2-digit', minute: '2-digit' })}
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
                <button className="btn" disabled={busy} onClick={() => bookAt(new Date(data.proposedStartsAt).toISOString())}>
                  {busy ? 'Booking…' : (<><Check size={14} /> Confirm this time</>)}
                </button>
                <button className="btn-ghost" disabled={busy} onClick={() => setPickMode(true)}>Pick another time</button>
              </div>
            </div>
          </div>
        </Card>
      ) : !data.ready ? (
        <Card>
          <EmptyState
            icon={<CalendarClock size={30} />}
            title="We'll set up your call together"
            body="Your Squideo team will be in touch shortly to lock in the perfect time for your kick-off call — keep an eye on your inbox, or just reply to your welcome email and we'll sort it."
          />
        </Card>
      ) : days.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CalendarClock size={30} />}
            title="No open times in the next couple of weeks"
            body="Everything's booked up for now — reply to your welcome email and we'll find a slot that works for you."
          />
        </Card>
      ) : (
        <>
          {data.proposedStartsAt && (
            <button className="btn-link" style={{ fontSize: 13, alignSelf: 'flex-start' }} onClick={() => setPickMode(false)}>← Back to the proposed time</button>
          )}
          <div style={{ fontSize: 12.5, color: BRAND.muted }}>Times shown in {tz.replace(/_/g, ' ')}. Each call is about {data.durationMinutes} minutes.</div>
          {days.map((d) => (
            <Card key={d.day}>
              <SectionHeading>{d.day}</SectionHeading>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {d.slots.map((s) => (
                  <button
                    key={s.start}
                    className="btn-ghost"
                    disabled={busy}
                    onClick={() => bookAt(s.start)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 88, justifyContent: 'center' }}
                  >
                    <Clock size={13} /> {fmt(s.start, tz, { hour: '2-digit', minute: '2-digit' })}
                  </button>
                ))}
              </div>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
