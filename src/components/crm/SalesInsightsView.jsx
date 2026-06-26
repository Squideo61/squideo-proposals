import React, { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from 'recharts';
import {
  ArrowLeft, Gauge, PoundSterling, Trophy, Target, Clock, Wallet, FileText,
  Activity, XCircle, AlertTriangle, Eye, Crown,
} from 'lucide-react';
import { BRAND, APP_MAX_WIDTH } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, useIsMobile } from '../../utils.js';
import { computeRange, rangeHeading, fmtRangeDates, RangeControl } from './dateRange.jsx';

const CARD_SHADOW = '0 1px 2px rgba(16,42,61,0.05)';
const STAGE_COLOR = {
  lead: '#64748B', responded: '#94A3B8', proposal_sent: '#F59E0B', viewed: '#0EA5E9',
  interested: '#7C3AED', signed: '#16A34A', paid: '#15803D', long_term: '#0D9488', lost: '#DC2626',
};

// Persist the chosen range across navigation (module-level, like the other dashboards).
const salesRangeMemory = { range: { mode: 'preset', days: 365 } };

const fmtDays = (n) => (n == null ? '—' : (n >= 100 ? Math.round(n) : Number(n).toFixed(n < 10 ? 1 : 0)) + 'd');
const fmtPct = (n) => (n == null ? '—' : Number(n).toFixed(1) + '%');
const monthShort = (k) => { const [y, m] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }); };
const ago = (iso) => {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + 'd ago';
};

export function SalesInsightsView({ onBack, onOpenDeal }) {
  const { actions } = useStore();
  const isMobile = useIsMobile();
  const [range, setRange] = useState(salesRangeMemory.range);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => { salesRangeMemory.range = range; }, [range]);
  const { from, to } = useMemo(() => computeRange(range), [range]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    actions.loadSalesInsights(from, to)
      .then((d) => { if (active) setData(d); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [from, to, actions]);

  return (
    <div style={{ padding: isMobile ? '20px 16px' : '32px 24px', maxWidth: APP_MAX_WIDTH, margin: '0 auto' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        {onBack && (
          <button onClick={onBack} className="btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 8px' }}>
            <ArrowLeft size={16} /> Back
          </button>
        )}
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, display: 'inline-flex', alignItems: 'center', gap: 9 }}>
          <Gauge size={22} style={{ color: BRAND.blue }} /> Sales Insights
        </h1>
        <div style={{ flex: 1 }} />
        <RangeControl range={range} setRange={setRange} />
      </header>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: BRAND.ink }}>{rangeHeading(range)}</span>
        <span style={{ fontSize: 13, color: BRAND.muted }}>{fmtRangeDates(from, to)}</span>
        <span style={{ fontSize: 13, color: BRAND.muted }}>
          · Pipeline is live; win rate, cycle, forecast &amp; bookings cover the period.
        </span>
      </div>

      {loading && !data ? <Loading /> : !data ? <Failed onRetry={() => setRange((r) => ({ ...r }))} /> : (
        <Insights data={data} isMobile={isMobile} onOpenDeal={onOpenDeal} />
      )}
    </div>
  );
}

function Insights({ data, isMobile, onOpenDeal }) {
  const k = data.kpis || {};
  const open = onOpenDeal || (() => {});

  return (
    <div>
      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 26 }}>
        <Stat icon={Wallet} label="Open pipeline" value={formatGBP(k.openValue)} sub={`${k.openCount || 0} open deals`} accent="#0EA5E9" />
        <Stat icon={Target} label="Weighted forecast" value={formatGBP(k.weightedForecast)} sub="stage-probability weighted" accent="#7C3AED" />
        <Stat icon={Trophy} label="Signed Proposals" value={formatGBP(k.wonValue)} sub={`${k.wonCount || 0} signed`} accent="#16A34A" colorValue />
        <Stat icon={Activity} label="Win rate" value={fmtPct(k.winRate)} sub={`${k.wonCount || 0} won · ${k.lostCount || 0} lost`} accent={k.winRate != null && k.winRate >= 40 ? '#16A34A' : '#F59E0B'} colorValue />
        <Stat icon={Clock} label="Avg sales cycle" value={fmtDays(k.avgCycleDays)} sub={k.medianCycleDays != null ? `median ${fmtDays(k.medianCycleDays)}` : null} accent="#F59E0B" />
        <Stat icon={PoundSterling} label="Avg deal size" value={k.avgDealValue == null ? '—' : formatGBP(k.avgDealValue)} sub={k.medianDealValue != null ? `median ${formatGBP(k.medianDealValue)}` : null} accent="#16A34A" />
      </div>

      {/* Pipeline by stage + Stage velocity */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0,1fr) minmax(0,1fr)', gap: 16, marginBottom: 26, alignItems: 'start' }}>
        <div>
          <SectionLabel>Open pipeline by stage</SectionLabel>
          <PipelineByStage rows={data.pipeline?.byStage || []} total={data.pipeline?.openValue || 0} />
        </div>
        <div>
          <SectionLabel>Stage funnel &amp; velocity</SectionLabel>
          <FunnelVelocity rows={data.funnel || []} />
        </div>
      </div>

      {/* Signed proposals trend */}
      <SectionLabel>Signed proposals — value by month</SectionLabel>
      <Panel style={{ marginBottom: 26 }}>
        <BookingsTrend rows={data.trend || []} />
      </Panel>

      {/* Rep leaderboard */}
      <SectionLabel>Sales rep performance</SectionLabel>
      <Panel style={{ marginBottom: 26, padding: 0 }}>
        <RepTable rows={data.reps || []} />
      </Panel>

      {/* Win/Loss + Deal size */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0,1fr) minmax(0,1fr)', gap: 16, marginBottom: 26, alignItems: 'start' }}>
        <div>
          <SectionLabel>Why deals are lost</SectionLabel>
          <LostReasons lost={data.lost || { byReason: [] }} />
        </div>
        <div>
          <SectionLabel>Deal size mix</SectionLabel>
          <DealSize dealSize={data.dealSize || { bands: [] }} />
        </div>
      </div>

      {/* Proposal engagement */}
      <SectionLabel>Proposal engagement → outcome</SectionLabel>
      <Engagement engagement={data.engagement || {}} onOpenDeal={open} isMobile={isMobile} />

      {/* Action lists */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0,1fr) minmax(0,1fr)', gap: 16, marginTop: 26, alignItems: 'start' }}>
        <div>
          <SectionLabel>Biggest open deals</SectionLabel>
          <DealList rows={data.dealSize?.biggestOpen || []} onOpenDeal={open} empty="No open deals with a value yet." />
        </div>
        <div>
          <SectionLabel>⚠️ Stalled — no activity in 14+ days</SectionLabel>
          <DealList rows={data.stalled || []} onOpenDeal={open} showStale empty="Nothing stalled — pipeline is moving." />
        </div>
      </div>
    </div>
  );
}

// ---- pieces ---------------------------------------------------------------

function SectionLabel({ children }) {
  return <h2 style={{ fontSize: 12.5, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6, margin: '0 0 12px' }}>{children}</h2>;
}
function Panel({ children, style }) {
  return <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 14, boxShadow: CARD_SHADOW, padding: '18px 20px', ...style }}>{children}</div>;
}
function Loading() { return <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted }}>Loading…</div>; }
function Empty({ children }) { return <div style={{ padding: 28, textAlign: 'center', color: BRAND.muted, fontSize: 13 }}>{children}</div>; }
function Failed({ onRetry }) {
  return <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted, border: '1px dashed ' + BRAND.border, borderRadius: 12 }}>
    <div style={{ marginBottom: 12 }}>Couldn’t load sales insights.</div>
    <button onClick={onRetry} className="btn-secondary" style={{ padding: '6px 14px' }}>Retry</button>
  </div>;
}
function Stat({ icon: Icon, label, value, sub, accent = BRAND.blue, colorValue }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 14, boxShadow: CARD_SHADOW, padding: '15px 16px', display: 'flex', gap: 13, alignItems: 'flex-start', minWidth: 0 }}>
      <div style={{ width: 38, height: 38, borderRadius: 11, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: accent + '1A', color: accent }}>
        <Icon size={19} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11.5, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
        <div style={{ fontSize: 23, fontWeight: 700, marginTop: 3, lineHeight: 1.1, color: colorValue ? accent : BRAND.ink, overflowWrap: 'anywhere' }}>{value}</div>
        {sub != null && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 3 }}>{sub}</div>}
      </div>
    </div>
  );
}

function PipelineByStage({ rows, total }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <Panel>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
        <span style={{ fontSize: 13, color: BRAND.muted }}>Total open</span>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{formatGBP(total)}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
        {rows.map((r) => (
          <div key={r.stage}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink }}>{r.label} <span style={{ color: BRAND.muted, fontWeight: 500 }}>· {r.count}</span></span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{formatGBP(r.value)}</span>
            </div>
            <div style={{ height: 12, borderRadius: 6, background: BRAND.paper, overflow: 'hidden' }}>
              <div style={{ width: Math.max(3, Math.round((r.value / max) * 100)) + '%', height: '100%', borderRadius: 6, background: STAGE_COLOR[r.stage] || BRAND.blue }} />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function FunnelVelocity({ rows }) {
  const maxDays = Math.max(...rows.map((r) => r.avgDaysInStage || 0), 1);
  return (
    <Panel style={{ padding: 0 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: BRAND.paper, textAlign: 'left' }}>
            <Th>Stage</Th><Th right>Reached</Th><Th right>Conv.</Th><Th right>Avg time in stage</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const bottleneck = (r.avgDaysInStage || 0) === maxDays && maxDays > 1;
            return (
              <tr key={r.stage} style={{ borderTop: '1px solid ' + BRAND.border }}>
                <Td><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: STAGE_COLOR[r.stage] || BRAND.muted, marginRight: 7 }} />{r.label}</Td>
                <Td right>{r.reached}<span style={{ color: BRAND.muted, fontSize: 11, marginLeft: 5 }}>{r.conversionFromStart != null ? r.conversionFromStart + '%' : ''}</span></Td>
                <Td right>{r.conversionFromPrev == null ? '—' : r.conversionFromPrev + '%'}</Td>
                <Td right>
                  <span style={{ color: bottleneck ? '#B45309' : BRAND.ink, fontWeight: bottleneck ? 700 : 500 }}>{fmtDays(r.avgDaysInStage)}</span>
                  {bottleneck && <span title="Slowest stage — likely bottleneck" style={{ marginLeft: 5 }}>🐢</span>}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}

function BookingsTrend({ rows }) {
  const chartData = rows.map((r) => ({ name: monthShort(r.month), value: r.value, count: r.count, month: r.month }));
  if (!rows.length || rows.every((r) => r.value === 0)) return <Empty>No signed deals in the last 12 months yet.</Empty>;
  return (
    <div style={{ height: 230 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#EEF1F4" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} width={54} tickFormatter={(v) => '£' + (v >= 1000 ? (v / 1000) + 'k' : v)} />
          <Tooltip formatter={(v, n) => (n === 'value' ? formatGBP(v) : v)} labelFormatter={(l) => l} />
          <Bar dataKey="value" name="Booked" radius={[5, 5, 0, 0]} maxBarSize={48} fill="#16A34A" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function RepTable({ rows }) {
  if (!rows.length) return <Empty>No deals assigned to reps yet.</Empty>;
  const topWon = Math.max(...rows.map((r) => r.wonValue), 0);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: BRAND.paper, textAlign: 'left' }}>
            <Th>Rep</Th><Th right>Open pipeline</Th><Th right>Open</Th><Th right>Won</Th><Th right>Booked</Th><Th right>Win rate</Th><Th right>Avg cycle</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.email || r.name} style={{ borderTop: '1px solid ' + BRAND.border }}>
              <Td>
                {r.wonValue === topWon && topWon > 0 && <Crown size={13} style={{ color: '#F59E0B', marginRight: 5, verticalAlign: '-2px' }} />}
                {r.name}
              </Td>
              <Td right>{formatGBP(r.openValue)}</Td>
              <Td right>{r.openCount}</Td>
              <Td right>{r.wonCount}</Td>
              <Td right><strong>{formatGBP(r.wonValue)}</strong></Td>
              <Td right>{fmtPct(r.winRate)}</Td>
              <Td right>{fmtDays(r.avgCycleDays)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LostReasons({ lost }) {
  const rows = lost.byReason || [];
  return (
    <Panel style={{ padding: rows.length ? 0 : '18px 20px' }}>
      {!rows.length ? <Empty>No lost deals in this period. 🎉</Empty> : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid ' + BRAND.border }}>
            <span style={{ fontSize: 13, color: BRAND.muted }}>{lost.count} lost</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#DC2626' }}>{formatGBP(lost.value)} value lost</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              {rows.map((r) => (
                <tr key={r.reason} style={{ borderTop: '1px solid ' + BRAND.border }}>
                  <Td><XCircle size={13} style={{ color: '#DC2626', marginRight: 7, verticalAlign: '-2px' }} />{r.reason}</Td>
                  <Td right>{r.count}</Td>
                  <Td right style={{ color: BRAND.muted }}>{formatGBP(r.value)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Panel>
  );
}

function DealSize({ dealSize }) {
  const bands = dealSize.bands || [];
  const max = Math.max(...bands.map((b) => b.count), 1);
  return (
    <Panel>
      <div style={{ display: 'flex', gap: 20, marginBottom: 16 }}>
        <div><div style={{ fontSize: 11.5, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase' }}>Average</div><div style={{ fontSize: 20, fontWeight: 700 }}>{dealSize.avg == null ? '—' : formatGBP(dealSize.avg)}</div></div>
        <div><div style={{ fontSize: 11.5, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase' }}>Median</div><div style={{ fontSize: 20, fontWeight: 700 }}>{dealSize.median == null ? '—' : formatGBP(dealSize.median)}</div></div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {bands.map((b) => (
          <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 64, fontSize: 12, color: BRAND.muted, flexShrink: 0 }}>{b.label}</span>
            <div style={{ flex: 1, height: 11, borderRadius: 6, background: BRAND.paper, overflow: 'hidden' }}>
              <div style={{ width: Math.max(b.count ? 6 : 0, Math.round((b.count / max) * 100)) + '%', height: '100%', borderRadius: 6, background: BRAND.blue }} />
            </div>
            <span style={{ width: 24, textAlign: 'right', fontSize: 12, fontWeight: 600 }}>{b.count}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function Engagement({ engagement, onOpenDeal, isMobile }) {
  const e = engagement;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0,0.9fr) minmax(0,1.1fr)', gap: 16, alignItems: 'start' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Stat icon={FileText} label="Proposals sent" value={e.sent ?? 0} accent="#0EA5E9" />
        <Stat icon={Eye} label="View rate" value={fmtPct(e.viewRate)} sub={`${e.viewed ?? 0} opened`} accent="#7C3AED" />
        <Stat icon={Trophy} label="Win — viewed" value={fmtPct(e.winRateViewed)} sub="opened the proposal" accent="#16A34A" colorValue />
        <Stat icon={XCircle} label="Win — not viewed" value={fmtPct(e.winRateNotViewed)} sub="never opened" accent="#94A3B8" />
      </div>
      <div>
        <Panel style={{ padding: 0 }}>
          <div style={{ padding: '12px 18px', borderBottom: '1px solid ' + BRAND.border, fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7 }}>
            <Eye size={14} style={{ color: '#7C3AED' }} /> Follow up — opened, still open
          </div>
          {(!e.followUp || !e.followUp.length) ? <Empty>No open proposals have been opened recently.</Empty> : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <tbody>
                {e.followUp.map((d) => (
                  <tr key={d.id} onClick={() => onOpenDeal(d.id)} style={{ borderTop: '1px solid ' + BRAND.border, cursor: 'pointer' }}>
                    <Td><div style={{ fontWeight: 600 }}>{d.title}</div><div style={{ fontSize: 11, color: BRAND.muted }}>{d.stageLabel} · {d.opens} open{d.opens === 1 ? '' : 's'} · last {ago(d.lastOpenedAt)}</div></Td>
                    <Td right><strong>{formatGBP(d.value)}</strong></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}

function DealList({ rows, onOpenDeal, showStale, empty }) {
  return (
    <Panel style={{ padding: 0 }}>
      {!rows.length ? <Empty>{empty}</Empty> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} onClick={() => onOpenDeal(d.id)} style={{ borderTop: '1px solid ' + BRAND.border, cursor: 'pointer' }}>
                <Td>
                  <div style={{ fontWeight: 600 }}>{d.title}</div>
                  <div style={{ fontSize: 11, color: BRAND.muted }}>
                    <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: STAGE_COLOR[d.stage] || BRAND.muted, marginRight: 5 }} />
                    {d.stageLabel}{showStale && d.daysStale != null ? ` · ${d.daysStale}d stale` : ''}
                  </div>
                </Td>
                <Td right>
                  {showStale && <AlertTriangle size={13} style={{ color: d.daysStale >= 30 ? '#DC2626' : '#F59E0B', marginRight: 6, verticalAlign: '-2px' }} />}
                  <strong>{formatGBP(d.value)}</strong>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function Th({ children, right }) {
  return <th style={{ padding: '10px 14px', fontSize: 12, fontWeight: 600, color: BRAND.muted, textAlign: right ? 'right' : 'left', whiteSpace: 'nowrap' }}>{children}</th>;
}
function Td({ children, right, style }) {
  return <td style={{ padding: '10px 14px', textAlign: right ? 'right' : 'left', color: BRAND.ink, ...style }}>{children}</td>;
}
