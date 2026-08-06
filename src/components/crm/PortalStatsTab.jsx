// Marketing → Portal. How many people take a portal account, where they come
// from, and whether they come back.
//
// Two decisions shape what's shown:
//
// A signup is split by ROUTE — a crash-course signup created its own account
// off a marketing page; an invited client was handed one by a producer after a
// deal was signed. Only the first is marketing's. Reporting one number would
// let invite volume, which tracks sales, read as marketing performance.
//
// A visit is a SIGN-IN, not a page view. The portal keeps a session, so page
// views mostly count someone scrolling around one visit — which would make
// engagement look like return traffic.

import React, { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { RefreshCw, GraduationCap, UserPlus, LogIn, Repeat, FileText } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { useIsMobile } from '../../utils.js';

const shortDay = (iso) => {
  const d = new Date(iso + 'T00:00:00Z');
  return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
};

function Tile({ Icon, label, value, sub, tone = BRAND.blue }) {
  return (
    <div style={{
      background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10,
      padding: '13px 15px', flex: '1 1 170px', minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
        <Icon size={14} color={tone} />
        <span style={{ fontSize: 11.5, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          {label}
        </span>
      </div>
      <div style={{ fontSize: 25, fontWeight: 800, color: BRAND.ink, lineHeight: 1.05 }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: BRAND.muted, marginTop: 4, lineHeight: 1.4 }}>{sub}</div>}
    </div>
  );
}

function Chart({ data, colour, isMobile }) {
  return (
    <div style={{ height: isMobile ? 160 : 200 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 6, right: 4, left: -22, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#EEF2F5" vertical={false} />
          <XAxis
            dataKey="day" tickFormatter={shortDay} tick={{ fontSize: 10.5, fill: BRAND.muted }}
            axisLine={false} tickLine={false} minTickGap={22}
          />
          <YAxis allowDecimals={false} tick={{ fontSize: 10.5, fill: BRAND.muted }} axisLine={false} tickLine={false} />
          <Tooltip
            labelFormatter={shortDay}
            contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid ' + BRAND.border }}
          />
          <Bar dataKey="n" fill={colour} radius={[3, 3, 0, 0]} name="Count" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function PortalStatsTab({ from, to }) {
  const isMobile = useIsMobile();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setError(null);
    setData(null);
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    api.get('/api/crm/portal-analytics?' + q.toString())
      .then(setData)
      .catch((e) => setError(e.message));
  }, [from, to, reload]);

  const act = data?.activation || {};
  // Ordered as the journey runs, so a drop-off is visible by reading down.
  const funnel = useMemo(() => ([
    { label: 'Watched the course', value: act.watched_course || 0 },
    { label: 'Finished a video', value: act.finished_a_video || 0 },
    { label: 'Started a brief', value: act.briefs_started || 0 },
    { label: 'Sent us a brief', value: act.briefs_sent || 0 },
    { label: 'Requested a video', value: act.video_requests || 0 },
  ]), [act]);

  if (error) {
    return (
      <div style={{ padding: 30, textAlign: 'center', color: BRAND.muted, fontSize: 13.5 }}>
        Couldn't load portal stats — {error}
        <div style={{ marginTop: 12 }}>
          <button className="btn-ghost" onClick={() => setReload((n) => n + 1)}><RefreshCw size={13} /> Try again</button>
        </div>
      </div>
    );
  }
  if (!data) return <div style={{ padding: 30, textAlign: 'center', color: BRAND.muted, fontSize: 13.5 }}>Loading…</div>;

  const s = data.signups;
  const v = data.visits;
  const maxFunnel = Math.max(1, ...funnel.map((f) => f.value));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Tile
          Icon={GraduationCap} label="From the course" value={s.course}
          sub="Signed themselves up off a marketing page"
        />
        {/* Only once the brief builder has actually brought someone in. A tile
            reading zero on every load is noise on a page whose job is to make
            the routes distinguishable. */}
        {s.brief > 0 && (
          <Tile
            Icon={FileText} label="From the brief" value={s.brief} tone="#7C5CD1"
            sub="Started a video brief off a marketing page"
          />
        )}
        <Tile
          Icon={UserPlus} label="Invited by us" value={s.invite} tone="#7C3AED"
          sub="Handed an account after a deal — sales, not marketing"
        />
        <Tile
          Icon={LogIn} label="Sign-ins" value={v.total} tone="#16A34A"
          sub={`${v.people} ${v.people === 1 ? 'person' : 'people'} · ${v.perPerson} each`}
        />
        <Tile
          Icon={Repeat} label="Came back" value={v.returning} tone="#F59E0B"
          sub={v.people ? `${Math.round((v.returning / v.people) * 100)}% returned on another day` : 'On more than one day'}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 14 }}>
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink, marginBottom: 2 }}>New accounts</div>
          <div style={{ fontSize: 11.5, color: BRAND.muted, marginBottom: 10 }}>
            {s.total} in this period{s.other > 0 && ` · ${s.other} we couldn't attribute to a route`}
          </div>
          <Chart data={s.byDay} colour={BRAND.blue} isMobile={isMobile} />
        </div>
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink, marginBottom: 2 }}>Sign-ins</div>
          <div style={{ fontSize: 11.5, color: BRAND.muted, marginBottom: 10 }}>
            A visit is a sign-in, not a page view
          </div>
          <Chart data={v.byDay} colour="#16A34A" isMobile={isMobile} />
        </div>
      </div>

      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink, marginBottom: 2 }}>What they did in there</div>
        <div style={{ fontSize: 11.5, color: BRAND.muted, marginBottom: 12 }}>
          The numbers that say whether a signup was worth having. Counted when it happened, so
          someone who signed up last month and sent a brief this week counts here.
        </div>
        {funnel.map((f) => (
          <div key={f.label} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <div style={{ width: isMobile ? 118 : 150, flexShrink: 0, fontSize: 12.5, color: BRAND.ink }}>{f.label}</div>
            <div style={{ flex: 1, background: '#F1F5F9', borderRadius: 999, height: 9, overflow: 'hidden' }}>
              <div style={{ width: `${(f.value / maxFunnel) * 100}%`, height: '100%', background: BRAND.blue }} />
            </div>
            <div style={{ width: 34, textAlign: 'right', fontSize: 13, fontWeight: 700, color: BRAND.ink }}>{f.value}</div>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 11.5, color: BRAND.muted, lineHeight: 1.55 }}>
        {data.totals.accounts} portal accounts in total
        {data.totals.never_signed_in > 0 && ` · ${data.totals.never_signed_in} have never signed in`}.
        Staff previews aren't counted anywhere here.
        {data.excluded > 0 && (
          <> {data.excluded} internal {data.excluded === 1 ? 'account is' : 'accounts are'} excluded
            {' '}— our own test signups and anyone on a @squideo address.</>
        )}
      </div>
    </div>
  );
}
