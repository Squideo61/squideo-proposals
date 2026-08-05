// The Partner Programme, inside the portal.
//
// It used to be a link to squideo.com — which meant a client who was interested
// left the portal to read a sales page written for strangers, and the only way
// back was the browser's back button. This is the same offer told to someone we
// already work with, ending in a booked call rather than a quote form.
//
// No price anywhere. The programme is scoped on the call — how much content,
// how often, what shape — and a number seen beforehand becomes the anchor every
// later conversation has to argue against. Same reason the brief builder asks
// for a budget band instead of publishing a rate.
import React, { useEffect, useMemo, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState, SectionHeading } from '../components.jsx';
import {
  CalendarClock, Check, Clock, Video, PiggyBank, Shuffle, Zap, TrendingDown, Handshake,
} from 'lucide-react';

const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'Europe/London'; } };

function fmt(dateISO, tz, opts) {
  try { return new Date(dateISO).toLocaleString('en-GB', { timeZone: tz, ...opts }); }
  catch { return new Date(dateISO).toLocaleString('en-GB', opts); }
}

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

// The four pillars from the public page, in the second person — they're already
// a client, so "your team" and "your content", not "organisations that…".
const PILLARS = [
  {
    Icon: PiggyBank,
    title: 'A predictable monthly budget',
    body: 'One agreed monthly figure instead of a quote per project. Easier to get signed off once, and easier to plan a year of content around.',
  },
  {
    Icon: Shuffle,
    title: 'Credits you can spend how you like',
    body: 'Unused credit banks up. Spend it on a long piece, a run of short ones, cutdowns, versions or updates — whatever the month actually calls for.',
  },
  {
    Icon: Zap,
    title: 'Faster turnaround',
    body: 'We hold production capacity for you in advance, so your work starts sooner and moves through fewer steps to get going.',
  },
  {
    Icon: TrendingDown,
    title: 'Better value the more you make',
    body: 'Your style, characters and assets carry across everything, so each video costs less to make than the one before — and you get that back in the rate.',
  },
];

export default function Partner() {
  const { showToast } = usePortal();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  const load = async () => {
    try { setData(await portalApi.get('partner')); }
    catch (err) { setError(err.message); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tz = data?.timezone || 'Europe/London';
  const days = useMemo(() => groupByDay(data?.slots || [], tz), [data, tz]);

  const bookAt = async (startsAt) => {
    setBusy(true);
    try {
      const res = await portalApi.post('partner-book', { startsAt, timezone: browserTz() });
      setData((d) => ({ ...d, booking: res.booking }));
      showToast('Your Partner Programme call is booked 🎉');
    } catch (err) {
      showToast(err.message);
      if (err.status === 409) load(); // slot gone — refresh availability
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return <Card><EmptyState title="Couldn't load the Partner Programme" body={error} /></Card>;
  }
  if (!data) return <div style={{ color: BRAND.muted, fontSize: 13, padding: 30, textAlign: 'center' }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {/* ── The offer ── */}
      <div style={{
        background: 'linear-gradient(135deg, #0B2740 0%, #123A5A 100%)',
        borderRadius: 14, padding: '26px 26px 24px', color: 'white',
      }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, background: '#2BB8E633',
          color: '#7FDBFF', fontSize: 11, fontWeight: 800, letterSpacing: 0.5,
          textTransform: 'uppercase', padding: '4px 10px', borderRadius: 5, marginBottom: 12,
        }}>
          <Handshake size={13} /> Partner Programme
        </div>
        <h1 style={{ margin: '0 0 8px', fontSize: 25, fontWeight: 800, lineHeight: 1.2 }}>
          Bank flexible video credits every month
        </h1>
        <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6, opacity: 0.92, maxWidth: 620 }}>
          Instead of re-quoting every project, subscribe and bank monthly credits. Use them for
          new videos, edits, cutdowns, versions or updates — at your pace.
        </p>
        <div style={{
          marginTop: 16, display: 'inline-block', background: '#FFFFFF14',
          border: '1px solid #FFFFFF2E', borderRadius: 8, padding: '8px 14px',
          fontSize: 13.5, fontWeight: 700,
        }}>
          1 video credit = 60 seconds of finished video
        </div>
      </div>

      {/* ── Why ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 12 }}>
        {PILLARS.map(({ Icon, title, body }) => (
          <Card key={title}>
            <Icon size={20} color={BRAND.blue} />
            <div style={{ fontSize: 14.5, fontWeight: 700, color: BRAND.ink, margin: '10px 0 5px' }}>{title}</div>
            <div style={{ fontSize: 13, color: BRAND.muted, lineHeight: 1.55 }}>{body}</div>
          </Card>
        ))}
      </div>

      <Card>
        <p style={{ margin: 0, fontSize: 13.5, color: BRAND.ink, lineHeight: 1.6 }}>
          It's built for teams that want <strong>consistent, ongoing video</strong> without starting
          from scratch each time. We'll build the plan around what you're actually making —
          <strong> there's no fixed package to fit into</strong>, which is why the next step is a
          conversation rather than a price list.
        </p>
      </Card>

      {/* ── Book the call ── */}
      {data.booking ? (
        <Card>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: '#DCFCE7', color: '#16A34A', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Check size={20} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15.5, fontWeight: 800, color: BRAND.ink, marginBottom: 4 }}>Your call is booked</div>
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
      ) : !data.ready || days.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CalendarClock size={30} />}
            title="Let's find a time"
            body="There's nothing open in the next couple of weeks. Reply to any email from your Squideo team and we'll get a Partner Programme chat in the diary."
          />
        </Card>
      ) : !picking ? (
        <Card>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: '#EAF7FC', color: BRAND.blue, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <CalendarClock size={20} />
            </div>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: BRAND.ink, marginBottom: 4 }}>
                Talk it through with us
              </div>
              <div style={{ fontSize: 13.5, color: BRAND.muted, lineHeight: 1.55 }}>
                About {data.durationMinutes} minutes on Google Meet. We'll look at what you're
                planning to make and what a monthly plan would look like for you — no obligation.
              </div>
              <button className="btn" style={{ marginTop: 14 }} onClick={() => setPicking(true)}>
                <CalendarClock size={14} /> Book a call
              </button>
            </div>
          </div>
        </Card>
      ) : (
        <>
          <SectionHeading>Pick a time</SectionHeading>
          <div style={{ fontSize: 12.5, color: BRAND.muted, marginTop: -8 }}>
            Times shown in {tz.replace(/_/g, ' ')}. Each call is about {data.durationMinutes} minutes.
          </div>
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
