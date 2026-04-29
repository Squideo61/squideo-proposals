import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Trophy } from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { BRAND } from '../theme.js';
import { useStore } from '../store.jsx';
import { formatGBP, useIsMobile } from '../utils.js';

const SERIES_COLORS = ['#2BB8E6', '#0F2A3D', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6'];

const RANGE_OPTIONS = [
  { value: 'month', label: 'This month' },
  { value: 'year', label: 'Past 12 months' },
  { value: 'all', label: 'All time' },
];

function bucketKey(d, grain) {
  const dt = new Date(d);
  if (grain === 'day') {
    return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
  }
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0');
}

function bucketLabel(key, grain) {
  if (grain === 'day') {
    const [y, m, d] = key.split('-');
    const dt = new Date(Number(y), Number(m) - 1, Number(d));
    return dt.toLocaleString('en-GB', { day: 'numeric', month: 'short' });
  }
  const [y, m] = key.split('-');
  const dt = new Date(Number(y), Number(m) - 1, 1);
  return dt.toLocaleString('en-GB', { month: 'short', year: '2-digit' });
}

function buildTrendSeries(trendRows, grain) {
  const buckets = new Set();
  const byUser = {};
  for (const row of trendRows) {
    const k = bucketKey(row.bucket, grain);
    buckets.add(k);
    if (!byUser[row.email]) byUser[row.email] = {};
    byUser[row.email][k] = (byUser[row.email][k] || 0) + (row.count || 0);
  }
  const sortedBuckets = Array.from(buckets).sort();
  const data = sortedBuckets.map((k) => {
    const point = { bucket: bucketLabel(k, grain) };
    for (const email of Object.keys(byUser)) {
      point[email] = byUser[email][k] || 0;
    }
    return point;
  });
  return { data, users: Object.keys(byUser) };
}

export function LeaderboardView({ onBack }) {
  const { state, actions } = useStore();
  const [range, setRange] = useState('month');
  const [loading, setLoading] = useState(true);
  const [trendMode, setTrendMode] = useState('signed');
  const isMobile = useIsMobile();

  useEffect(() => {
    let active = true;
    setLoading(true);
    actions.loadLeaderboard(range).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [actions, range]);

  const board = state.leaderboard || { totals: [], createdTrend: [], signedTrend: [], grain: 'day', periodLabel: '' };
  const totals = useMemo(
    () => (board.totals || []).filter(t => t.email && t.email !== 'unknown'),
    [board.totals]
  );

  const userNameByEmail = useMemo(() => {
    const m = {};
    for (const t of totals) m[t.email] = t.name || t.email;
    return m;
  }, [totals]);

  const grain = board.grain || (range === 'month' ? 'day' : 'month');
  const trendSeries = useMemo(
    () => buildTrendSeries(trendMode === 'signed' ? (board.signedTrend || []) : (board.createdTrend || []), grain),
    [board.signedTrend, board.createdTrend, trendMode, grain]
  );

  const podium = totals.slice(0, 3);
  const maxSigned = Math.max(1, ...totals.map(t => t.signed));
  const periodLabel = board.periodLabel || RANGE_OPTIONS.find(o => o.value === range)?.label || '';
  const isStale = board.range && board.range !== range;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: isMobile ? '20px 16px' : '40px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Trophy size={22} color={BRAND.blue} />
              <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>{periodLabel} Leaderboard</h1>
            </div>
            <p style={{ fontSize: 13, color: BRAND.muted, margin: '2px 0 0' }}>
              {range === 'month'
                ? 'Counts reset on the 1st — created, signed, and paid in this calendar month.'
                : range === 'year'
                  ? 'Activity over the past 12 months.'
                  : 'All-time totals across the workspace.'}
            </p>
          </div>
        </div>
        <div style={{ display: 'inline-flex', border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden', background: 'white' }}>
          {RANGE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setRange(opt.value)}
              style={{
                padding: '8px 14px',
                fontSize: 13,
                fontWeight: 600,
                border: 'none',
                cursor: 'pointer',
                background: range === opt.value ? BRAND.blue : 'white',
                color: range === opt.value ? 'white' : BRAND.ink,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </header>

      {loading && !isStale ? (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 60, textAlign: 'center', color: BRAND.muted }}>
          Loading leaderboard…
        </div>
      ) : totals.length === 0 ? (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 60, textAlign: 'center' }}>
          <Trophy size={40} color={BRAND.muted} style={{ marginBottom: 12 }} />
          <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>No activity {range === 'month' ? 'this month' : range === 'year' ? 'in the past 12 months' : 'yet'}</h3>
          <p style={{ color: BRAND.muted, fontSize: 14, margin: 0 }}>
            {range === 'month' ? 'Create or sign a proposal and the leaderboard will populate.' : 'Try a wider range or create some proposals.'}
          </p>
        </div>
      ) : (
        <>
          {podium.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(' + podium.length + ', 1fr)', gap: 12, marginBottom: 24 }}>
              {podium.map((t, i) => (
                <PodiumCard key={t.email} rank={i + 1} entry={t} />
              ))}
            </div>
          )}

          <Section title="Created vs Signed">
            <div style={{ width: '100%', height: 320 }}>
              <ResponsiveContainer>
                <BarChart data={totals} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={BRAND.border} />
                  <XAxis dataKey="name" tick={{ fontSize: 12, fill: BRAND.muted }} />
                  <YAxis tick={{ fontSize: 12, fill: BRAND.muted }} allowDecimals={false} />
                  <Tooltip cursor={{ fill: 'rgba(43,184,230,0.06)' }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="created" name="Created" fill="#0F2A3D" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="signed" name="Signed" fill="#2BB8E6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Section>

          <Section title="Revenue generated">
            <div style={{ width: '100%', height: 320 }}>
              <ResponsiveContainer>
                <BarChart data={totals} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={BRAND.border} />
                  <XAxis dataKey="name" tick={{ fontSize: 12, fill: BRAND.muted }} />
                  <YAxis tick={{ fontSize: 12, fill: BRAND.muted }} tickFormatter={(v) => '£' + Math.round(v / 1000) + 'k'} />
                  <Tooltip formatter={(v) => formatGBP(v)} cursor={{ fill: 'rgba(43,184,230,0.06)' }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="dealValue" name="Signed deal value" fill="#10B981" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="revenuePaid" name="Paid revenue" fill="#2BB8E6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Section>

          <Section
            title={range === 'month' ? 'Daily trend' : range === 'year' ? 'Monthly trend' : 'All-time trend'}
            right={
              <div style={{ display: 'inline-flex', border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden' }}>
                {['signed', 'created'].map((m) => (
                  <button
                    key={m}
                    onClick={() => setTrendMode(m)}
                    style={{
                      padding: '6px 12px',
                      fontSize: 12,
                      fontWeight: 600,
                      border: 'none',
                      cursor: 'pointer',
                      background: trendMode === m ? BRAND.blue : 'white',
                      color: trendMode === m ? 'white' : BRAND.ink,
                    }}
                  >
                    {m === 'signed' ? 'Signed' : 'Created'}
                  </button>
                ))}
              </div>
            }
          >
            {trendSeries.data.length === 0 ? (
              <p style={{ color: BRAND.muted, fontSize: 14, margin: '20px 0' }}>
                No {trendMode} activity in this range yet.
              </p>
            ) : (
              <div style={{ width: '100%', height: 320 }}>
                <ResponsiveContainer>
                  <LineChart data={trendSeries.data} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={BRAND.border} />
                    <XAxis dataKey="bucket" tick={{ fontSize: 12, fill: BRAND.muted }} />
                    <YAxis tick={{ fontSize: 12, fill: BRAND.muted }} allowDecimals={false} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    {trendSeries.users.map((email, i) => (
                      <Line
                        key={email}
                        type="monotone"
                        dataKey={email}
                        name={userNameByEmail[email] || email}
                        stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                        strokeWidth={2}
                        dot={{ r: 3 }}
                        activeDot={{ r: 5 }}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </Section>

          <Section title="Standings">
            <LeaderboardTable totals={totals} maxSigned={maxSigned} isMobile={isMobile} />
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, right, children }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: BRAND.muted }}>{title}</h2>
        {right}
      </div>
      {children}
    </div>
  );
}

function PodiumCard({ rank, entry }) {
  const medals = ['🥇', '🥈', '🥉'];
  const tints = ['#FEF3C7', '#E5E7EB', '#FCE7D6'];
  return (
    <div style={{ background: tints[rank - 1] || '#fff', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 28 }}>{medals[rank - 1]}</div>
        <Avatar entry={entry} size={40} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</div>
          <div style={{ fontSize: 12, color: BRAND.muted }}>{entry.signed} signed · {entry.created} created</div>
        </div>
      </div>
      <div style={{ marginTop: 12, fontSize: 13, color: BRAND.ink }}>
        <strong>{formatGBP(entry.dealValue)}</strong> <span style={{ color: BRAND.muted }}>signed value</span>
      </div>
    </div>
  );
}

function Avatar({ entry, size = 32 }) {
  const initial = (entry.name || '?')[0].toUpperCase();
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden', flexShrink: 0, background: BRAND.blue, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: size * 0.42 }}>
      {entry.avatar
        ? <img src={entry.avatar} alt={entry.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : initial}
    </div>
  );
}

function LeaderboardTable({ totals, maxSigned, isMobile }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid ' + BRAND.border, color: BRAND.muted, textAlign: 'left' }}>
            <th style={{ padding: '10px 8px', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>#</th>
            <th style={{ padding: '10px 8px', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>User</th>
            <th style={{ padding: '10px 8px', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, textAlign: 'right' }}>Created</th>
            <th style={{ padding: '10px 8px', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, textAlign: 'right' }}>Signed</th>
            {!isMobile && <th style={{ padding: '10px 8px', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, textAlign: 'right' }}>Conv.</th>}
            <th style={{ padding: '10px 8px', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, textAlign: 'right' }}>Deal value</th>
            {!isMobile && <th style={{ padding: '10px 8px', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, textAlign: 'right' }}>Paid revenue</th>}
            {!isMobile && <th style={{ padding: '10px 8px', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, width: 140 }}>Signed share</th>}
          </tr>
        </thead>
        <tbody>
          {totals.map((t, i) => {
            const conv = t.created > 0 ? Math.round((t.signed / t.created) * 100) : 0;
            const pct = Math.round((t.signed / maxSigned) * 100);
            return (
              <tr key={t.email} style={{ borderBottom: '1px solid ' + BRAND.border }}>
                <td style={{ padding: '10px 8px', color: BRAND.muted, fontWeight: 600 }}>{i + 1}</td>
                <td style={{ padding: '10px 8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Avatar entry={t} size={28} />
                    <div>
                      <div style={{ fontWeight: 600 }}>{t.name}</div>
                      <div style={{ fontSize: 11, color: BRAND.muted }}>{t.email}</div>
                    </div>
                  </div>
                </td>
                <td style={{ padding: '10px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{t.created}</td>
                <td style={{ padding: '10px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{t.signed}</td>
                {!isMobile && <td style={{ padding: '10px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: BRAND.muted }}>{conv}%</td>}
                <td style={{ padding: '10px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatGBP(t.dealValue)}</td>
                {!isMobile && <td style={{ padding: '10px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatGBP(t.revenuePaid)}</td>}
                {!isMobile && (
                  <td style={{ padding: '10px 8px' }}>
                    <div style={{ background: BRAND.border, borderRadius: 999, height: 8, overflow: 'hidden' }}>
                      <div style={{ width: pct + '%', background: BRAND.blue, height: '100%' }} />
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
