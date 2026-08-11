// Marketing → Video guide. Who signed up for the video guide, how far they got,
// and which of them is worth a call today.
//
// The commercially useful output of this whole feature is the hot list. A
// signup notification is noise; "watched 6 of 8 and asked for a quote" is a
// call worth making that afternoon. So the hot band leads, and every score
// shows its reasons on hover — a number nobody can interrogate gets ignored.

import React, { useEffect, useMemo, useState } from 'react';
import { Flame, GraduationCap, RefreshCw, ExternalLink } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { useIsMobile } from '../../utils.js';
import { ResponsiveTable } from '../ui.jsx';
import { CourseReach } from './CourseReach.jsx';

const BANDS = {
  hot:  { label: 'Hot',  bg: '#FEF2F2', border: '#FECACA', ink: '#B91C1C' },
  warm: { label: 'Warm', bg: '#FFF8EB', border: '#F5C26B', ink: '#B45309' },
  cool: { label: 'Cool', bg: '#F1F5F9', border: BRAND.border, ink: BRAND.muted },
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—');
const ago = (d) => {
  if (!d) return 'never';
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return fmtDate(d);
};

export function CourseLeadsTab({ onOpenContact, from, to }) {
  const isMobile = useIsMobile();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [band, setBand] = useState('all');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setError(null);
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    api.get('/api/crm/course/analytics?' + q.toString()).then(setData).catch((e) => setError(e.message));
  }, [reload, from, to]);

  const rows = useMemo(() => {
    const all = data?.signups || [];
    const filtered = band === 'all' ? all : all.filter((r) => r.band === band);
    // Hottest first, then most recently active — the order someone works down.
    return [...filtered].sort((a, b) =>
      (b.score - a.score) || (new Date(b.lastActiveAt || 0) - new Date(a.lastActiveAt || 0)));
  }, [data, band]);

  if (error) {
    return (
      <div style={{ padding: 30, textAlign: 'center', color: BRAND.muted, fontSize: 13.5 }}>
        Couldn't load course data — {error}
        <div style={{ marginTop: 12 }}>
          <button className="btn-ghost" onClick={() => setReload((n) => n + 1)}><RefreshCw size={13} /> Try again</button>
        </div>
      </div>
    );
  }
  if (!data) return <div style={{ padding: 30, color: BRAND.muted, fontSize: 13.5 }}>Loading…</div>;

  const f = data.funnel;
  const videos = data.videos || [];

  return (
    <div>
      <CourseReach reach={data.reach} isMobile={isMobile} />

      <Funnel f={f} isMobile={isMobile} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '22px 0 12px', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: BRAND.ink }}>
          Signups ({data.signups.length})
        </h3>
        <div style={{ flex: 1 }} />
        {['all', 'hot', 'warm', 'cool'].map((b) => (
          <button
            key={b}
            onClick={() => setBand(b)}
            style={{
              fontSize: 12, fontWeight: band === b ? 700 : 600, padding: '4px 11px',
              borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
              background: band === b ? BRAND.ink : '#fff',
              color: band === b ? '#fff' : BRAND.muted,
              border: '1px solid ' + (band === b ? BRAND.ink : BRAND.border),
            }}
          >
            {b === 'all' ? 'All' : BANDS[b].label}
            {b === 'hot' && data.hot > 0 && ` (${data.hot})`}
            {b === 'warm' && data.warm > 0 && ` (${data.warm})`}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: 30, textAlign: 'center', color: BRAND.muted, fontSize: 13.5, border: '1px dashed ' + BRAND.border, borderRadius: 10 }}>
          {data.signups.length === 0
            ? 'No signups yet. Once the course page is linked from the website they\'ll appear here.'
            : 'Nobody in that band yet.'}
        </div>
      ) : (
        <ResponsiveTable
          columns={[
            { key: 'who', label: 'Who', render: (r) => (
              <div>
                <div style={{ fontWeight: 600, color: BRAND.ink }}>{r.name || r.email}</div>
                <div style={{ fontSize: 11.5, color: BRAND.muted }}>
                  {r.companyName || r.email}
                </div>
              </div>
            ) },
            { key: 'progress', label: 'Watched', render: (r) => (
              <Pips videos={videos} done={r.doneModuleIds} count={r.videosDone} />
            ) },
            { key: 'signedUp', label: 'Signed up', hideOnMobile: true, render: (r) => fmtDate(r.signedUpAt) },
            { key: 'lastActive', label: 'Last active', render: (r) => ago(r.lastActiveAt) },
            { key: 'enquiries', label: 'Enquiry', align: 'right', render: (r) => (r.enquiries > 0 ? '✓' : '—') },
            { key: 'score', label: 'Score', align: 'right', render: (r) => <Score row={r} /> },
          ]}
          rows={rows}
          onRowClick={(r) => r.contactId && onOpenContact?.(r.contactId)}
          empty="No signups"
        />
      )}

      <h3 style={{ margin: '26px 0 10px', fontSize: 15, fontWeight: 700, color: BRAND.ink }}>
        Where people drop off
      </h3>
      <div style={{ fontSize: 12.5, color: BRAND.muted, marginBottom: 10 }}>
        The video with the steepest fall is the one worth re-cutting.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {videos.map((v) => {
          const rate = v.starts ? Math.round((v.completions / v.starts) * 100) : 0;
          return (
            <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
              <span style={{ width: 22, color: BRAND.muted, fontWeight: 700 }}>{v.moduleNumber}</span>
              <span style={{ flex: '1 1 200px', minWidth: 0, color: BRAND.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {v.title}{v.free && <span style={{ color: '#15803D', fontWeight: 700 }}> · free</span>}
              </span>
              <span style={{ flex: '2 1 160px', height: 6, borderRadius: 999, background: '#EEF3F7', overflow: 'hidden' }}>
                <span style={{ display: 'block', width: `${rate}%`, height: '100%', background: BRAND.blue }} />
              </span>
              <span style={{ width: 108, textAlign: 'right', color: BRAND.muted }}>
                {v.completions}/{v.starts} finished
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Funnel({ f, isMobile }) {
  const steps = [
    { label: 'Visited', value: f.pageViews },
    { label: 'Played', value: f.plays },
    { label: 'Signed up', value: f.signups },
    { label: 'Started', value: f.started },
    { label: 'Finished', value: f.completed },
    { label: 'Enquired', value: f.enquiries },
  ];
  return (
    <div style={{
      display: 'grid', gap: 8,
      gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : `repeat(${steps.length}, 1fr)`,
    }}>
      {steps.map((s, i) => {
        const prev = i > 0 ? steps[i - 1].value : null;
        const rate = prev ? Math.round((s.value / prev) * 100) : null;
        return (
          <div key={s.label} style={{
            background: '#fff', border: '1px solid ' + BRAND.border,
            borderRadius: 10, padding: '11px 13px',
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {s.label}
            </div>
            <div style={{ fontSize: 21, fontWeight: 800, color: BRAND.ink, lineHeight: 1.2 }}>{s.value}</div>
            {rate != null && Number.isFinite(rate) && (
              <div style={{ fontSize: 11, color: BRAND.muted }}>{rate}% of previous</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// One pip per published video, filled when finished. Reads at a glance in a
// way "5/8" doesn't — you can see WHICH ones they stopped at.
function Pips({ videos, done, count }) {
  const set = new Set(done || []);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }} title={`${count} of ${videos.length} finished`}>
      {videos.map((v) => (
        <span
          key={v.id}
          style={{
            width: 9, height: 9, borderRadius: 2,
            background: set.has(v.id) ? BRAND.blue : '#E2E9EF',
          }}
        />
      ))}
    </span>
  );
}

function Score({ row }) {
  const b = BANDS[row.band] || BANDS.cool;
  const why = (row.reasons || []).map((r) => `+${r.points} ${r.why}`).join('\n') || 'No signals yet';
  return (
    <span
      title={why}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'help',
        fontSize: 11.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
        background: b.bg, border: `1px solid ${b.border}`, color: b.ink,
      }}
    >
      {row.band === 'hot' && <Flame size={11} />}
      {b.label} {row.score}
    </span>
  );
}
