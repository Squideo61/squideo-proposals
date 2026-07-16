import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from 'recharts';
import { ArrowLeft, BarChart3, MailQuestion, LayoutDashboard, Megaphone, Check, Copy, TrendingUp, RefreshCw, Search, Globe, Users, UserCheck, FileText, Trophy, PoundSterling, Wallet, Target, Coins, Clock, Gauge, XCircle, ChevronLeft, ChevronRight, Plus, Mail, Phone, Link2, Inbox } from 'lucide-react';
import { BRAND, APP_MAX_WIDTH } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, useIsMobile } from '../../utils.js';
import { CallLink, Modal } from './../ui.jsx';
import { computeRange, rangeHeading, fmtRangeDates, segBtn, RangeControl, thisMonthStr } from './dateRange.jsx';

// Remembers the Marketing page's view state across navigation (mirrors
// financeViewMemory): the active tab, report grouping, date range and scroll.
const marketingViewMemory = { section: 'overview', groupBy: 'campaign', range: { mode: 'month', month: thisMonthStr() }, scrollY: 0 };

const CHANNEL_LABELS = {
  paid_search: 'Paid search',
  organic: 'Organic',
  social: 'Social',
  referral: 'Referral',
  direct: 'Direct',
  email: 'Email',
  phone: 'Phone',
  other: 'Other',
};
const CHANNEL_COLORS = {
  paid_search: '#2BB8E6',
  organic: '#16A34A',
  social: '#7C3AED',
  referral: '#F59E0B',
  direct: '#94A3B8',
  email: '#0EA5E9',
  phone: '#14B8A6',
  other: '#94A3B8',
};
const prettyChannel = (c) => CHANNEL_LABELS[c] || c || '—';

const GROUP_OPTIONS = [
  { key: 'campaign', label: 'Campaign' },
  { key: 'keyword', label: 'Keyword' },
  { key: 'source', label: 'Source' },
  { key: 'medium', label: 'Medium' },
  { key: 'channel', label: 'Channel' },
];

const TABS = [
  { key: 'overview', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'reports', label: 'Reports', icon: BarChart3 },
  { key: 'leads', label: 'Leads', icon: MailQuestion },
  { key: 'search', label: 'Search', icon: Search },
  { key: 'traffic', label: 'Traffic', icon: Globe },
  { key: 'settings', label: 'Settings', icon: Megaphone },
];

const pct = (n) => (n == null ? '—' : (Number(n) || 0).toFixed(1) + '%');
const dash = (v, fmt) => (v == null ? '—' : fmt(v));
// Whole-pound currency for the headline KPI tiles. Pence are noise at this size
// and dropping them keeps the figure on one line (no "£30,775⏎.00" wrap).
const gbp0 = (n) => '£' + Math.round(Number(n) || 0).toLocaleString('en-GB');
const fmtRoas = (v) => (v == null ? '—' : (Number(v) || 0).toFixed(2) + '×');

export function MarketingView({ section: sectionProp, onBack, onOpenCompany }) {
  const { state, actions } = useStore();
  const isMobile = useIsMobile();
  const [section, setSection] = useState(sectionProp || marketingViewMemory.section);
  const [range, setRange] = useState(marketingViewMemory.range);
  const [groupBy, setGroupBy] = useState(marketingViewMemory.groupBy);

  const [overview, setOverview] = useState(null);   // reports grouped by channel
  const [report, setReport] = useState(null);       // reports grouped by groupBy
  const [leads, setLeads] = useState(null);
  const [search, setSearch] = useState(null);       // Search Console organic report
  const [traffic, setTraffic] = useState(null);     // GA4 traffic-by-channel report
  const [snippet, setSnippet] = useState(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0); // bump to re-run the active fetch (Retry)

  // Follow the section coming from the header (navigate('marketing', <section>)).
  useEffect(() => { if (sectionProp) setSection(sectionProp); }, [sectionProp]);
  useEffect(() => { marketingViewMemory.section = section; }, [section]);
  useEffect(() => { marketingViewMemory.range = range; }, [range]);
  useEffect(() => { marketingViewMemory.groupBy = groupBy; }, [groupBy]);

  const { from, to } = useMemo(() => computeRange(range), [range]);

  // The "show leads from" cutoff — leads before it (incomplete early attribution)
  // are excluded from the lead-based reports so they don't skew the figures.
  const cutoff = state.marketingCutoff || null;
  useEffect(() => { actions.loadMarketingCutoff(); }, [actions]);
  const onCutoffChange = (v) => {
    if (!v) return;
    actions.setMarketingCutoff(v).then(() => setReload((n) => n + 1));
  };

  // Dashboard: channel-grouped report carries both the totals (headline cards)
  // and the per-channel breakdown.
  useEffect(() => {
    if (section !== 'overview') return;
    let active = true;
    setLoading(true);
    actions.loadMarketingReports('channel', from, to)
      .then((d) => { if (active) setOverview(d); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [section, from, to, actions, reload]);

  useEffect(() => {
    if (section !== 'reports') return;
    let active = true;
    setLoading(true);
    actions.loadMarketingReports(groupBy, from, to)
      .then((d) => { if (active) setReport(d); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [section, groupBy, from, to, actions, reload]);

  useEffect(() => {
    if (section !== 'leads') return;
    let active = true;
    setLoading(true);
    actions.loadMarketingLeads(from, to)
      .then((d) => { if (active) setLeads(d); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [section, from, to, actions, reload]);

  useEffect(() => {
    if (section !== 'search') return;
    let active = true;
    setLoading(true);
    actions.loadMarketingSearch(from, to)
      .then((d) => { if (active) setSearch(d); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [section, from, to, actions, reload]);

  useEffect(() => {
    if (section !== 'traffic') return;
    let active = true;
    setLoading(true);
    actions.loadMarketingTraffic(from, to)
      .then((d) => { if (active) setTraffic(d); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [section, from, to, actions, reload]);

  useEffect(() => {
    if (section !== 'settings' || snippet) return;
    actions.loadMarketingSnippet().then((d) => setSnippet(d));
  }, [section, snippet, actions]);

  const adsConfigured = overview?.adsConfigured ?? report?.adsConfigured ?? snippet?.adsConfigured ?? false;

  return (
    <div style={{ padding: isMobile ? '20px 16px' : '32px 24px', maxWidth: APP_MAX_WIDTH, margin: '0 auto' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        {onBack && (
          <button onClick={onBack} className="btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 8px' }}>
            <ArrowLeft size={16} /> Back
          </button>
        )}
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Marketing</h1>
        <div style={{ flex: 1 }} />
        {section !== 'settings' && <RangeControl range={range} setRange={setRange} />}
      </header>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid ' + BRAND.border, marginBottom: 24, flexWrap: 'wrap' }}>
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = section === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setSection(t.key)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 14px',
                border: 'none', background: 'none', cursor: 'pointer', fontSize: 14,
                fontWeight: active ? 600 : 500, color: active ? BRAND.blue : BRAND.ink,
                borderBottom: '2px solid ' + (active ? BRAND.blue : 'transparent'), marginBottom: -1,
              }}
            >
              <Icon size={15} /> {t.label}
            </button>
          );
        })}
      </div>

      {/* Active period — labels each tab so screenshots are self-explanatory. */}
      {section !== 'settings' && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '0 0 18px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 17, fontWeight: 700, color: BRAND.ink }}>{rangeHeading(range)}</span>
          <span style={{ fontSize: 13, color: BRAND.muted }}>{fmtRangeDates(from, to)}</span>
        </div>
      )}

      {section === 'overview' && <OverviewTab data={overview} loading={loading} adsConfigured={adsConfigured} onOpenSettings={() => setSection('settings')} onRetry={() => setReload((n) => n + 1)} isMobile={isMobile} />}
      {section === 'reports' && (
        <ReportsTab
          data={report} loading={loading} groupBy={groupBy} setGroupBy={setGroupBy} adsConfigured={adsConfigured}
          onRetry={() => setReload((n) => n + 1)}
        />
      )}
      {section === 'leads' && <LeadsTab data={leads} loading={loading} onOpenCompany={onOpenCompany} onRetry={() => setReload((n) => n + 1)} />}
      {section === 'search' && <SearchTab data={search} loading={loading} onOpenSettings={() => setSection('settings')} onRetry={() => setReload((n) => n + 1)} />}
      {section === 'traffic' && <TrafficTab data={traffic} loading={loading} onOpenSettings={() => setSection('settings')} onRetry={() => setReload((n) => n + 1)} />}
      {section === 'settings' && <SettingsTab snippet={snippet} onSync={() => actions.syncAdSpend()} onReloadStatus={() => actions.loadMarketingSnippet().then((d) => d && setSnippet(d))} cutoff={cutoff} onCutoffChange={onCutoffChange} />}
    </div>
  );
}

// ---- shared bits ---------------------------------------------------------

// `compact` shrinks the tile so three of them sit comfortably on one row (used
// by the Traffic tab, which only has three metrics); the four-metric tabs keep
// the roomier default and wrap to two lines on a phone.
function Card({ label, value, sub, accent, compact = false }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: compact ? '11px 12px' : '16px 18px', minWidth: 0 }}>
      <div style={{ fontSize: compact ? 10.5 : 12, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ fontSize: compact ? 20 : 24, fontWeight: 700, marginTop: compact ? 3 : 6, color: accent || BRAND.ink }}>{value}</div>
      {sub != null && <div style={{ fontSize: compact ? 10.5 : 12, color: BRAND.muted, marginTop: compact ? 2 : 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>}
    </div>
  );
}

const CARD_SHADOW = '0 1px 2px rgba(16,42,61,0.05)';

// Small uppercase section heading to group the dashboard into bands.
function SectionLabel({ children, style }) {
  return (
    <h2 style={{ fontSize: 12.5, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6, margin: '0 0 12px', ...style }}>
      {children}
    </h2>
  );
}

// Icon-chip stat tile. `accent` colours the icon chip + (optionally) the value.
function StatCard({ icon: Icon, label, value, sub, accent = BRAND.blue, big = false, colorValue = false }) {
  const isMobile = useIsMobile();
  return (
    <div style={{
      background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 14, boxShadow: CARD_SHADOW,
      padding: isMobile ? '13px 13px' : (big ? '18px 20px' : '15px 16px'), display: 'flex', gap: isMobile ? 10 : 13, alignItems: 'flex-start', minWidth: 0,
    }}>
      <div style={{
        width: isMobile ? 32 : (big ? 42 : 38), height: isMobile ? 32 : (big ? 42 : 38), borderRadius: 11, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: accent + '1A', color: accent,
      }}>
        <Icon size={isMobile ? 17 : (big ? 21 : 19)} />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 11.5, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
        {/* Keep the figure on one line — mid-digit wrapping reads as broken. It
            shrinks on mobile and ellipsises only as a last resort. */}
        <div style={{ fontSize: isMobile ? 18 : (big ? 28 : 23), fontWeight: 700, marginTop: 3, lineHeight: 1.15, color: colorValue ? accent : BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
        {sub != null && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 3 }}>{sub}</div>}
      </div>
    </div>
  );
}

// Horizontal-bar funnel: each stage's bar width is its share of the top stage,
// with the count + its % of all leads. Reads top-to-bottom as the lead journey.
function Funnel({ stages }) {
  const top = Math.max(stages[0]?.value || 0, 1);
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 14, boxShadow: CARD_SHADOW, padding: '18px 20px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {stages.map((s) => {
          const Icon = s.icon;
          const w = Math.max(4, Math.round((s.value / top) * 100));
          return (
            <div key={s.label}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <Icon size={15} style={{ color: s.color }} /> {s.label}
                </span>
                <span style={{ fontSize: 13, color: BRAND.muted, whiteSpace: 'nowrap' }}>
                  <strong style={{ color: BRAND.ink, fontSize: 16 }}>{s.value}</strong>
                  {s.pct != null && <span style={{ marginLeft: 8 }}>{s.pct}%</span>}
                </span>
              </div>
              <div style={{ height: 13, borderRadius: 7, background: BRAND.paper, overflow: 'hidden' }}>
                <div style={{ width: w + '%', height: '100%', borderRadius: 7, background: s.color, transition: 'width .35s ease' }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Loading() {
  return <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted }}>Loading…</div>;
}
function Empty({ children }) {
  return <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted, border: '1px dashed ' + BRAND.border, borderRadius: 12 }}>{children}</div>;
}
function LoadFailed({ onRetry }) {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted, border: '1px dashed ' + BRAND.border, borderRadius: 12 }}>
      <div style={{ marginBottom: 12 }}>Couldn’t load marketing data. Your session may have expired, or there was a temporary glitch.</div>
      {onRetry && <button onClick={onRetry} className="btn-secondary" style={{ padding: '6px 14px' }}>Retry</button>}
    </div>
  );
}

// Relative "time ago" for a sync timestamp (e.g. "3 hours ago", "just now").
function timeAgo(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24); return `${d} day${d === 1 ? '' : 's'} ago`;
}

// Persistent "last sync" indicator for a Marketing data source. `status` is the
// { ok, message, rowCount, ranAt } object the API returns as `lastSync` — written
// by both the daily cron and the manual "Sync now", so a silently-failing sync is
// always visible. Renders nothing until a sync has ever run.
function LastSync({ status, name }) {
  if (!status || !status.ranAt) return null;
  const when = timeAgo(status.ranAt);
  const ok = status.ok;
  const rows = status.rowCount;
  const prefix = name ? `${name} · ` : '';
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 500,
      color: ok ? '#166534' : '#991B1B', background: ok ? '#F0FDF4' : '#FEF2F2',
      border: '1px solid ' + (ok ? '#BBF7D0' : '#FECACA'), padding: '5px 11px', borderRadius: 999,
    }}>
      {ok ? <Check size={13} /> : <XCircle size={13} />}
      {ok
        ? <span>{prefix}Last synced {when}{rows != null ? ` · ${fmtNum(rows)} rows` : ''}</span>
        : <span>{prefix}Last sync failed{when ? ` (${when})` : ''}: {status.message || 'unknown error'}</span>}
    </div>
  );
}

// ---- Dashboard -----------------------------------------------------------

function OverviewTab({ data, loading, adsConfigured, onOpenSettings, onRetry, isMobile }) {
  if (loading && !data) return <Loading />;
  // A valid response is always an object (even with zero leads). `data == null`
  // after loading means the request failed — show a retry, never the misleading
  // "connect Google Ads" banner or a screen full of zeros.
  if (!data) return <LoadFailed onRetry={onRetry} />;
  const t = data?.totals || { leads: 0, qualified: 0, disqualified: 0, proposalsSent: 0, sales: 0, revenue: 0, proposalValueSent: 0, spend: null, roas: null, costPerLead: null, costPerSale: null, conversionRate: 0, leadToSaleRate: 0, avgLeadToSaleDays: null, qualityRate: null };
  const channels = (data?.rows || []).slice().sort((a, b) => b.leads - a.leads);
  const chartData = channels.map((r) => ({ name: prettyChannel(r.key), leads: r.leads, revenue: r.revenue, key: r.key }));

  const ofLeads = (n) => (t.leads ? Math.round(((n || 0) / t.leads) * 100) : null);
  const funnel = [
    { label: 'Leads', value: t.leads, color: '#64748B', icon: Users, pct: t.leads ? 100 : 0 },
    { label: 'Qualified', value: t.qualified, color: '#2BB8E6', icon: UserCheck, pct: ofLeads(t.qualified) },
    { label: 'Proposals sent', value: t.proposalsSent || 0, color: '#F59E0B', icon: FileText, pct: ofLeads(t.proposalsSent) },
    { label: 'Sales', value: t.sales, color: '#16A34A', icon: Trophy, pct: ofLeads(t.sales) },
  ];
  const qualityAccent = t.qualityRate == null ? '#64748B' : (t.qualityRate >= 50 ? '#16A34A' : '#DC2626');

  return (
    <div>
      {!adsConfigured && (
        <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 10, padding: '10px 14px', marginBottom: 18, fontSize: 13, color: '#9A3412', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Megaphone size={15} />
          <span>Connect Google Ads to see spend, cost-per-lead and ROAS.</span>
          <button onClick={onOpenSettings} className="btn-link" style={{ fontWeight: 600 }}>Finish setup →</button>
        </div>
      )}

      {/* Funnel + headline outcomes */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1.35fr) minmax(0, 1fr)', gap: 16, marginBottom: 26, alignItems: 'start' }}>
        <div>
          <SectionLabel>Lead funnel</SectionLabel>
          <Funnel stages={funnel} />
        </div>
        <div>
          <SectionLabel>Outcome</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <StatCard icon={Trophy} label="Sales" value={t.sales} sub={pct(t.leadToSaleRate) + ' lead→sale'} accent="#16A34A" colorValue big />
            <StatCard icon={PoundSterling} label="Revenue" value={gbp0(t.revenue)} sub="signed value" accent="#16A34A" big />
            <StatCard icon={FileText} label="Proposal value" value={gbp0(t.proposalValueSent)} sub="sent in period" accent="#0EA5E9" />
            <StatCard icon={Clock} label="Avg lead→sale" value={t.avgLeadToSaleDays == null ? '—' : t.avgLeadToSaleDays + ' days'} accent="#7C3AED" />
          </div>
        </div>
      </div>

      {/* Spend, efficiency & quality */}
      <SectionLabel>Spend, efficiency &amp; quality</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))', gap: 12, marginBottom: 26 }}>
        <StatCard icon={Wallet} label="Ad spend" value={dash(t.spend, gbp0)} accent="#F59E0B" />
        <StatCard icon={Target} label="Cost / lead" value={dash(t.costPerLead, gbp0)} accent="#F59E0B" />
        <StatCard icon={Coins} label="Cost / sale" value={dash(t.costPerSale, gbp0)} accent="#F59E0B" />
        <StatCard icon={TrendingUp} label="ROAS" value={fmtRoas(t.roas)} accent={t.roas != null && t.roas >= 1 ? '#16A34A' : '#64748B'} colorValue />
        <StatCard icon={Gauge} label="Lead quality" value={t.qualityRate == null ? '—' : Math.round(t.qualityRate) + '%'} sub="qualified of reviewed" accent={qualityAccent} colorValue />
        <StatCard icon={XCircle} label="Disqualified" value={t.disqualified ?? 0} sub={t.leads ? ofLeads(t.disqualified) + '% of leads' : null} accent="#DC2626" />
      </div>

      {/* By channel */}
      <SectionLabel>By channel</SectionLabel>
      {channels.length === 0 ? <Empty>No leads in this period yet.</Empty> : (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 14, boxShadow: CARD_SHADOW, padding: '18px 20px' }}>
          <div style={{ height: 220, marginBottom: 18, maxWidth: 620 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#EEF1F4" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v, n) => (n === 'revenue' ? formatGBP(v) : v)} />
                <Bar dataKey="leads" name="Leads" radius={[5, 5, 0, 0]} maxBarSize={64}>
                  {chartData.map((d) => <Cell key={d.key} fill={CHANNEL_COLORS[d.key] || BRAND.blue} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <ChannelTable rows={channels} adsConfigured={adsConfigured} />
        </div>
      )}
    </div>
  );
}

function ChannelTable({ rows, adsConfigured }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: BRAND.paper, textAlign: 'left' }}>
            <Th>Channel</Th><Th right>Leads</Th><Th right>Qualified</Th><Th right>Disqualified</Th><Th right>Quality</Th><Th right>Sales</Th><Th right>Proposal £</Th><Th right>Revenue</Th>
            {adsConfigured && <><Th right>Spend</Th><Th right>Cost/lead</Th><Th right>Cost/sale</Th><Th right>ROAS</Th></>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} style={{ borderTop: '1px solid ' + BRAND.border }}>
              <Td><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: CHANNEL_COLORS[r.key] || BRAND.muted, marginRight: 8 }} />{prettyChannel(r.key)}</Td>
              <Td right>{r.leads}</Td>
              <Td right>{r.qualified ?? 0}</Td>
              <Td right>{r.disqualified ?? 0}</Td>
              <Td right>{r.qualityRate == null ? '—' : Math.round(r.qualityRate) + '%'}</Td>
              <Td right>{r.sales ?? r.won ?? 0}</Td>
              <Td right>{formatGBP(r.proposalValue || 0)}</Td>
              <Td right>{formatGBP(r.revenue)}</Td>
              {adsConfigured && <><Td right>{dash(r.spend, formatGBP)}</Td><Td right>{dash(r.costPerLead, formatGBP)}</Td><Td right>{dash(r.costPerSale, formatGBP)}</Td><Td right>{fmtRoas(r.roas)}</Td></>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Reports -------------------------------------------------------------

function ReportsTab({ data, loading, groupBy, setGroupBy, adsConfigured, onRetry }) {
  const [sortKey, setSortKey] = useState('revenue');
  const [sortDir, setSortDir] = useState('desc');
  const rows = useMemo(() => {
    const r = (data?.rows || []).slice();
    r.sort((a, b) => {
      const av = a[sortKey] ?? -Infinity, bv = b[sortKey] ?? -Infinity;
      if (typeof av === 'string') return sortDir === 'asc' ? String(av).localeCompare(bv) : String(bv).localeCompare(av);
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return r;
  }, [data, sortKey, sortDir]);

  const sortBy = (k) => { if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSortKey(k); setSortDir('desc'); } };
  const arrow = (k) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <div>
      <div style={{ display: 'inline-flex', gap: 2, background: BRAND.paper, borderRadius: 8, padding: 2, marginBottom: 18, flexWrap: 'wrap' }}>
        {GROUP_OPTIONS.map((g) => (
          <button key={g.key} onClick={() => setGroupBy(g.key)} style={segBtn(groupBy === g.key)}>{g.label}</button>
        ))}
      </div>
      {loading && !data ? <Loading /> : !data ? <LoadFailed onRetry={onRetry} /> : rows.length === 0 ? <Empty>No leads in this period yet.</Empty> : (
        <div style={{ overflowX: 'auto', border: '1px solid ' + BRAND.border, borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: BRAND.paper, textAlign: 'left' }}>
                <Th onClick={() => sortBy('label')} clickable>{GROUP_OPTIONS.find((g) => g.key === groupBy)?.label}{arrow('label')}</Th>
                <Th right onClick={() => sortBy('leads')} clickable>Leads{arrow('leads')}</Th>
                <Th right onClick={() => sortBy('qualified')} clickable>Qualified{arrow('qualified')}</Th>
                <Th right onClick={() => sortBy('disqualified')} clickable>Disq.{arrow('disqualified')}</Th>
                <Th right onClick={() => sortBy('qualityRate')} clickable>Quality{arrow('qualityRate')}</Th>
                <Th right onClick={() => sortBy('sales')} clickable>Sales{arrow('sales')}</Th>
                <Th right onClick={() => sortBy('proposalValue')} clickable>Proposal £{arrow('proposalValue')}</Th>
                <Th right onClick={() => sortBy('conversionRate')} clickable>L→sale{arrow('conversionRate')}</Th>
                <Th right onClick={() => sortBy('revenue')} clickable>Revenue{arrow('revenue')}</Th>
                {adsConfigured && <>
                  <Th right onClick={() => sortBy('spend')} clickable>Spend{arrow('spend')}</Th>
                  <Th right onClick={() => sortBy('costPerLead')} clickable>Cost/lead{arrow('costPerLead')}</Th>
                  <Th right onClick={() => sortBy('costPerSale')} clickable>Cost/sale{arrow('costPerSale')}</Th>
                  <Th right onClick={() => sortBy('roas')} clickable>ROAS{arrow('roas')}</Th>
                </>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} style={{ borderTop: '1px solid ' + BRAND.border }}>
                  <Td title={r.label}>
                    {groupBy === 'channel' ? prettyChannel(r.key)
                      : groupBy === 'campaign' ? (
                        <div>
                          <div>{r.label || '—'}</div>
                          {r.campaignId && r.label !== r.campaignId && (
                            <div style={{ fontSize: 11, color: BRAND.muted }}>{r.campaignId}</div>
                          )}
                        </div>
                      ) : (r.label || '—')}
                  </Td>
                  <Td right>{r.leads}</Td>
                  <Td right>{r.qualified}</Td>
                  <Td right>{r.disqualified ?? 0}</Td>
                  <Td right>{r.qualityRate == null ? '—' : Math.round(r.qualityRate) + '%'}</Td>
                  <Td right>{r.sales ?? r.won ?? 0}</Td>
                  <Td right>{formatGBP(r.proposalValue || 0)}</Td>
                  <Td right>{pct(r.conversionRate)}</Td>
                  <Td right>{formatGBP(r.revenue)}</Td>
                  {adsConfigured && <><Td right>{dash(r.spend, formatGBP)}</Td><Td right>{dash(r.costPerLead, formatGBP)}</Td><Td right>{dash(r.costPerSale, formatGBP)}</Td><Td right>{fmtRoas(r.roas)}</Td></>}
                </tr>
              ))}
            </tbody>
            {data?.totals && (
              <tfoot>
                <tr style={{ borderTop: '2px solid ' + BRAND.border, fontWeight: 700, background: BRAND.paper }}>
                  <Td>Total</Td>
                  <Td right>{data.totals.leads}</Td>
                  <Td right>{data.totals.qualified}</Td>
                  <Td right>{data.totals.disqualified ?? 0}</Td>
                  <Td right>{data.totals.qualityRate == null ? '—' : Math.round(data.totals.qualityRate) + '%'}</Td>
                  <Td right>{data.totals.sales ?? data.totals.won ?? 0}</Td>
                  <Td right>{formatGBP(data.totals.proposalValueSent || 0)}</Td>
                  <Td right>{pct(data.totals.conversionRate)}</Td>
                  <Td right>{formatGBP(data.totals.revenue)}</Td>
                  {adsConfigured && <><Td right>{dash(data.totals.spend, formatGBP)}</Td><Td right>{dash(data.totals.costPerLead, formatGBP)}</Td><Td right>{dash(data.totals.costPerSale, formatGBP)}</Td><Td right>{fmtRoas(data.totals.roas)}</Td></>}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {!adsConfigured && rows.length > 0 && (
        <p style={{ fontSize: 12, color: BRAND.muted, marginTop: 12 }}>Connect Google Ads (Settings) to add spend, cost-per-lead and ROAS columns.</p>
      )}
    </div>
  );
}

// ---- Leads log -----------------------------------------------------------

const STATUS_STYLE = {
  new: { bg: '#EEF2FF', fg: '#3730A3', label: 'New' },
  qualified: { bg: '#DCFCE7', fg: '#166534', label: 'Qualified' },
  disqualified: { bg: '#FEE2E2', fg: '#991B1B', label: 'Disqualified' },
  spam: { bg: '#F1E9E9', fg: '#7F1D1D', label: 'Spam' },
};

// Sales-pipeline stage shown per lead (deal stage). Colour-grouped: won = green,
// lost = red, in-flight = amber, early = slate.
const STAGE_STYLE = {
  lead:          { bg: '#F1F5F9', fg: '#475569', label: 'Lead' },
  responded:     { bg: '#F1F5F9', fg: '#475569', label: 'Responded' },
  proposal_sent: { bg: '#FEF3C7', fg: '#92400E', label: 'Proposal sent' },
  viewed:        { bg: '#FEF3C7', fg: '#92400E', label: 'Viewed' },
  interested:    { bg: '#FEF3C7', fg: '#92400E', label: 'Interested' },
  signed:        { bg: '#DCFCE7', fg: '#166534', label: 'Signed' },
  paid:          { bg: '#DCFCE7', fg: '#166534', label: 'Paid' },
  long_term:     { bg: '#DCFCE7', fg: '#166534', label: 'Long-term' },
  lost:          { bg: '#FEE2E2', fg: '#991B1B', label: 'Lost' },
};

function LeadsTab({ data, loading, onOpenCompany, onRetry }) {
  const [filter, setFilter] = useState('all'); // all | new | qualified | disqualified | spam
  const [selectedId, setSelectedId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showBackfill, setShowBackfill] = useState(false);
  // Selection is scoped to the active tab, so dropping it on a filter change
  // keeps Prev/Next paging within whatever section you're looking at.
  useEffect(() => { setSelectedId(null); }, [filter]);
  if (loading && !data) return <Loading />;
  if (!data) return <LoadFailed onRetry={onRetry} />;
  const allLeads = data?.leads || [];
  const counts = {
    all: allLeads.length,
    new: allLeads.filter((l) => (l.status || 'new') === 'new').length,
    qualified: allLeads.filter((l) => l.status === 'qualified').length,
    disqualified: allLeads.filter((l) => l.status === 'disqualified').length,
    spam: allLeads.filter((l) => l.status === 'spam').length,
  };
  const FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'new', label: 'New' },
    { key: 'qualified', label: 'Qualified' },
    { key: 'disqualified', label: 'Disqualified' },
    { key: 'spam', label: 'Spam' },
  ];
  const leads = filter === 'all' ? allLeads : allLeads.filter((l) => (l.status || 'new') === filter);
  const selIdx = selectedId ? leads.findIndex((l) => l.id === selectedId) : -1;
  const selectedLead = selIdx >= 0 ? leads[selIdx] : null;

  // Reload the leads log after a create/backfill so the new rows appear (they
  // only show if their enquiry date lands in the current range — the modals warn
  // about that).
  const afterChange = () => { onRetry?.(); };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'inline-flex', gap: 2, background: BRAND.paper, borderRadius: 8, padding: 2, flexWrap: 'wrap' }}>
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)} style={segBtn(filter === f.key)}>
              {f.label} <span style={{ opacity: 0.7 }}>{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowBackfill(true)} className="btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', fontSize: 13, fontWeight: 600 }}>
          <Inbox size={15} /> Find email enquiries
        </button>
        <button onClick={() => setShowAdd(true)} className="btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', fontSize: 13, fontWeight: 600 }}>
          <Plus size={15} /> Add lead
        </button>
      </div>
      {allLeads.length === 0 ? <Empty>No leads captured in this period yet — use <strong>Add lead</strong> to log an email or phone enquiry.</Empty> : (
      <>
      {leads.length === 0 ? <Empty>No {filter} leads in this period.</Empty> : (
      <div style={{ overflowX: 'auto', border: '1px solid ' + BRAND.border, borderRadius: 12 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: BRAND.paper, textAlign: 'left' }}>
            <Th>Date</Th><Th>Lead</Th><Th>Channel</Th><Th>Campaign</Th><Th>Keyword</Th><Th>Status</Th><Th>Stage</Th><Th right>Proposal</Th><Th right>Revenue</Th>
          </tr>
        </thead>
        <tbody>
          {leads.map((l) => {
            const st = STATUS_STYLE[l.status] || STATUS_STYLE.new;
            const stg = l.dealStage ? STAGE_STYLE[l.dealStage] : null;
            return (
              <tr
                key={l.id}
                onClick={() => setSelectedId(l.id)}
                style={{ borderTop: '1px solid ' + BRAND.border, cursor: 'pointer', background: l.id === selectedId ? BRAND.paper : undefined }}
              >
                <Td>{new Date(l.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</Td>
                <Td>
                  <div style={{ fontWeight: 600 }}>{l.name || l.email || 'Anonymous'}</div>
                  {l.company && <div style={{ fontSize: 12, color: BRAND.muted }}>{l.company}</div>}
                </Td>
                <Td><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: CHANNEL_COLORS[l.channel] || BRAND.muted, marginRight: 6 }} />{prettyChannel(l.channel)}</Td>
                <Td title={l.campaign || ''}>{l.campaign || (l.source || '—')}</Td>
                <Td title={l.keyword || ''}>{l.keyword || '—'}</Td>
                <Td><span style={{ background: st.bg, color: st.fg, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999 }}>{st.label}</span></Td>
                <Td>{stg ? <span style={{ background: stg.bg, color: stg.fg, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999 }}>{stg.label}</span> : <span style={{ color: BRAND.muted }}>—</span>}</Td>
                <Td right>{l.proposalValue != null ? formatGBP(l.proposalValue) : <span style={{ color: BRAND.muted }}>—</span>}</Td>
                <Td right>{l.won ? <span style={{ color: '#16A34A', fontWeight: 600 }}>{formatGBP(l.revenue)}</span> : <span style={{ color: BRAND.muted }}>—</span>}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      )}
      {selectedLead && (
        <LeadDetailPanel
          lead={selectedLead}
          index={selIdx}
          total={leads.length}
          onPrev={selIdx > 0 ? () => setSelectedId(leads[selIdx - 1].id) : null}
          onNext={selIdx < leads.length - 1 ? () => setSelectedId(leads[selIdx + 1].id) : null}
          onClose={() => setSelectedId(null)}
          onOpenCompany={onOpenCompany}
        />
      )}
      </>
      )}
      {showAdd && <AddLeadModal onClose={() => setShowAdd(false)} onCreated={afterChange} />}
      {showBackfill && <EmailBackfillModal onClose={() => setShowBackfill(false)} onApplied={afterChange} />}
    </div>
  );
}

// Shared field styles for the lead modals.
const fieldLabel = { display: 'block', fontSize: 12, fontWeight: 600, color: BRAND.muted, marginBottom: 4 };
const fieldInput = { width: '100%', padding: '8px 10px', border: '1px solid ' + BRAND.border, borderRadius: 8, fontSize: 14, boxSizing: 'border-box', background: 'white', color: BRAND.ink };

const LEAD_CHANNELS = [
  { key: 'email', label: 'Email', icon: Mail },
  { key: 'phone', label: 'Phone', icon: Phone },
  { key: 'referral', label: 'Referral', icon: Users },
  { key: 'other', label: 'Other', icon: MailQuestion },
];

// "Add lead" — log an off-web enquiry so it counts in the Marketing funnel.
// Optionally link it to an existing deal, in which case it lands "qualified" and
// its revenue flows through as a sale when that deal signs.
function AddLeadModal({ onClose, onCreated }) {
  const { state, actions } = useStore();
  const [channel, setChannel] = useState('email');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [phone, setPhone] = useState('');
  const [details, setDetails] = useState('');
  const [enquiryDate, setEnquiryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dealQuery, setDealQuery] = useState('');
  const [dealId, setDealId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const companiesById = state.companies || {};
  const dealsList = useMemo(() => Object.values(state.deals || {}), [state.deals]);
  const matches = useMemo(() => {
    const q = dealQuery.trim().toLowerCase();
    if (!q) return [];
    return dealsList
      .map((d) => ({ d, cName: (d.companyId && companiesById[d.companyId]?.name) || '' }))
      .filter(({ d, cName }) => (d.title || '').toLowerCase().includes(q) || cName.toLowerCase().includes(q))
      .slice(0, 8);
  }, [dealQuery, dealsList, companiesById]);
  const selectedDeal = dealId ? (state.deals || {})[dealId] : null;
  const selectedDealCompany = selectedDeal && selectedDeal.companyId ? companiesById[selectedDeal.companyId]?.name : null;

  const pickDeal = (d) => {
    setDealId(d.id);
    setDealQuery('');
    // Prefill company from the deal if we don't already have one typed.
    const cName = (d.companyId && companiesById[d.companyId]?.name) || '';
    if (!company && cName) setCompany(cName);
  };

  const canSave = !!(name.trim() || email.trim() || company.trim());
  const submit = async () => {
    if (!canSave || saving) return;
    setSaving(true); setError(null);
    const created = await actions.createManualLead({
      channel, name: name.trim() || null, email: email.trim() || null,
      company: company.trim() || null, phone: phone.trim() || null,
      projectDetails: details.trim() || null, enquiryDate, dealId,
    });
    setSaving(false);
    if (!created) { setError('Could not save the lead. Please try again.'); return; }
    onCreated?.();
    onClose();
  };

  return (
    <Modal onClose={onClose} maxWidth={520}>
      <h3 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Plus size={18} style={{ color: BRAND.blue }} /> Add lead
      </h3>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted }}>
        Log an enquiry that didn't come through the website form (email, phone, referral) so it counts in your Marketing funnel.
      </p>

      <label style={fieldLabel}>Channel</label>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {LEAD_CHANNELS.map((c) => {
          const Icon = c.icon; const on = channel === c.key;
          return (
            <button key={c.key} type="button" onClick={() => setChannel(c.key)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', fontSize: 13, fontWeight: 600, borderRadius: 8, cursor: 'pointer',
                border: '1px solid ' + (on ? BRAND.blue : BRAND.border), background: on ? BRAND.blue : 'white', color: on ? 'white' : BRAND.ink }}>
              <Icon size={14} /> {c.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div><label style={fieldLabel}>Name</label><input style={fieldInput} value={name} onChange={(e) => setName(e.target.value)} placeholder="Contact name" /></div>
        <div><label style={fieldLabel}>Company</label><input style={fieldInput} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company" /></div>
        <div><label style={fieldLabel}>Email</label><input style={fieldInput} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" /></div>
        <div><label style={fieldLabel}>Phone</label><input style={fieldInput} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Optional" /></div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={fieldLabel}>Enquiry date</label>
        <input style={{ ...fieldInput, maxWidth: 200 }} type="date" value={enquiryDate} onChange={(e) => setEnquiryDate(e.target.value)} />
        <span style={{ fontSize: 12, color: BRAND.muted, marginLeft: 8 }}>The lead only shows in a report period that includes this date.</span>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={fieldLabel}>Notes</label>
        <textarea style={{ ...fieldInput, minHeight: 60, resize: 'vertical' }} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="What did they ask for?" />
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={fieldLabel}>Link to a deal <span style={{ fontWeight: 400 }}>(optional — makes it count as a sale when the deal signs)</span></label>
        {selectedDeal ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid ' + BRAND.border, borderRadius: 8, background: BRAND.paper }}>
            <Link2 size={14} style={{ color: BRAND.blue }} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>{selectedDeal.title || 'Untitled deal'}</span>
            {selectedDealCompany && <span style={{ fontSize: 12, color: BRAND.muted }}>· {selectedDealCompany}</span>}
            <div style={{ flex: 1 }} />
            <button type="button" onClick={() => setDealId(null)} style={{ border: 'none', background: 'none', color: BRAND.muted, cursor: 'pointer', fontSize: 12 }}>Remove</button>
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            <input style={fieldInput} value={dealQuery} onChange={(e) => setDealQuery(e.target.value)} placeholder="Search deals by name or company…" />
            {matches.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8, marginTop: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', maxHeight: 220, overflowY: 'auto' }}>
                {matches.map(({ d, cName }) => (
                  <button key={d.id} type="button" onClick={() => pickDeal(d)}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', borderBottom: '1px solid ' + BRAND.border, background: 'white', cursor: 'pointer' }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{d.title || 'Untitled deal'}</div>
                    {cName && <div style={{ fontSize: 12, color: BRAND.muted }}>{cName}</div>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {error && <div style={{ fontSize: 13, color: '#DC2626', marginBottom: 12 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" onClick={onClose} className="btn-ghost" style={{ padding: '8px 14px' }}>Cancel</button>
        <button type="button" onClick={submit} disabled={!canSave || saving} className="btn" style={{ padding: '8px 16px', opacity: !canSave || saving ? 0.6 : 1 }}>
          {saving ? 'Saving…' : 'Add lead'}
        </button>
      </div>
    </Modal>
  );
}

// "Find email enquiries" — surfaces signed/active deals that arrived via the
// enquiries inbox (≥1 inbound email) but were never logged as a Marketing lead,
// and creates 'email' leads for the selected ones so historic sales stop being
// under-counted. Preview-then-apply so nothing is created blindly.
function EmailBackfillModal({ onClose, onApplied }) {
  const { actions } = useStore();
  const [loading, setLoading] = useState(true);
  const [candidates, setCandidates] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    let active = true;
    actions.loadEmailBackfill().then((rows) => {
      if (!active) return;
      setCandidates(rows);
      setSelected(new Set(rows.map((r) => r.dealId))); // default: all selected
      setLoading(false);
    });
    return () => { active = false; };
  }, [actions]);

  const toggle = (id) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allOn = candidates.length > 0 && selected.size === candidates.length;
  const toggleAll = () => setSelected(allOn ? new Set() : new Set(candidates.map((r) => r.dealId)));

  const apply = async () => {
    if (!selected.size || applying) return;
    setApplying(true);
    const created = await actions.applyEmailBackfill([...selected]);
    setApplying(false);
    if (created >= 0) { setDone(created); onApplied?.(); }
  };

  return (
    <Modal onClose={onClose} maxWidth={640}>
      <h3 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Inbox size={18} style={{ color: BRAND.blue }} /> Email enquiries not yet tracked
      </h3>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: BRAND.muted }}>
        These deals came in by email but were never logged as a Marketing lead. Create <strong>Email</strong> leads for them so they count in your funnel and revenue.
      </p>

      {done != null ? (
        <div style={{ padding: '20px 0', textAlign: 'center' }}>
          <Check size={28} style={{ color: '#16A34A' }} />
          <div style={{ fontSize: 15, fontWeight: 600, marginTop: 8 }}>Created {done} email {done === 1 ? 'lead' : 'leads'}.</div>
          <div style={{ fontSize: 13, color: BRAND.muted, marginTop: 4 }}>They'll appear in any report period that includes their enquiry date.</div>
          <button type="button" onClick={onClose} className="btn" style={{ marginTop: 16, padding: '8px 18px' }}>Done</button>
        </div>
      ) : loading ? (
        <Loading />
      ) : candidates.length === 0 ? (
        <div style={{ padding: '24px 0', textAlign: 'center', color: BRAND.muted, fontSize: 14 }}>
          🎉 Nothing to backfill — every email-sourced deal is already tracked.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <button type="button" onClick={toggleAll} className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }}>
              {allOn ? 'Deselect all' : 'Select all'}
            </button>
            <span style={{ fontSize: 12, color: BRAND.muted }}>{selected.size} of {candidates.length} selected</span>
          </div>
          <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, maxHeight: 340, overflowY: 'auto' }}>
            {candidates.map((c) => {
              const on = selected.has(c.dealId);
              const stg = c.stage ? STAGE_STYLE[c.stage] : null;
              return (
                <label key={c.dealId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: '1px solid ' + BRAND.border, cursor: 'pointer' }}>
                  <input type="checkbox" checked={on} onChange={() => toggle(c.dealId)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title || c.company || c.name || 'Untitled deal'}</div>
                    <div style={{ fontSize: 12, color: BRAND.muted }}>
                      {[c.company, c.email].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                  {stg && <span style={{ background: stg.bg, color: stg.fg, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999 }}>{stg.label}</span>}
                  <span style={{ fontSize: 12, color: BRAND.muted, width: 64, textAlign: 'right' }}>
                    {c.firstInboundAt ? new Date(c.firstInboundAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : ''}
                  </span>
                </label>
              );
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button type="button" onClick={onClose} className="btn-ghost" style={{ padding: '8px 14px' }}>Cancel</button>
            <button type="button" onClick={apply} disabled={!selected.size || applying} className="btn" style={{ padding: '8px 16px', opacity: !selected.size || applying ? 0.6 : 1 }}>
              {applying ? 'Creating…' : `Create ${selected.size} ${selected.size === 1 ? 'lead' : 'leads'}`}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

// Right-hand slide-over showing the full quote request for a Marketing lead, with
// Prev/Next paging scoped to the current filter tab. Esc / ✕ close it; clicking
// the scrim intentionally does NOT (matches the app's modal-behaviour rule).
function LeadDetailPanel({ lead, index, total, onPrev, onNext, onClose, onOpenCompany }) {
  const isMobile = useIsMobile();
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') onPrev?.();
      else if (e.key === 'ArrowRight') onNext?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPrev, onNext]);

  const st = STATUS_STYLE[lead.status] || STATUS_STYLE.new;
  const stg = lead.dealStage ? STAGE_STYLE[lead.dealStage] : null;
  const isSpam = lead.status === 'spam';

  return (
    <>
      <div onClick={undefined} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.35)', zIndex: 1000 }} />
      <div
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 1001,
          width: isMobile ? '100%' : 440, maxWidth: '100%',
          background: 'white', boxShadow: '-8px 0 30px rgba(0,0,0,0.12)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* Header + paging */}
        <div style={{ padding: '14px 16px', borderBottom: '1px solid ' + BRAND.border, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={onPrev} disabled={!onPrev} className="btn-ghost" style={{ padding: '4px 8px', opacity: onPrev ? 1 : 0.4 }} title="Previous (←)"><ChevronLeft size={16} /></button>
            <span style={{ fontSize: 12, color: BRAND.muted }}>{index + 1} of {total}</span>
            <button onClick={onNext} disabled={!onNext} className="btn-ghost" style={{ padding: '4px 8px', opacity: onNext ? 1 : 0.4 }} title="Next (→)"><ChevronRight size={16} /></button>
            <button onClick={onClose} className="btn-ghost" style={{ padding: 4, marginLeft: 'auto' }} title="Close (Esc)"><XCircle size={18} /></button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {lead.name || lead.email || 'Anonymous'}
            </h2>
            <span style={{ background: st.bg, color: st.fg, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, flexShrink: 0 }}>{st.label}</span>
          </div>
          <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 3 }}>
            Submitted {new Date(lead.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          <PanelSection title="Contact">
            {lead.email && <PanelField label="Email"><a href={`mailto:${lead.email}`} style={{ color: BRAND.blue }}>{lead.email}</a></PanelField>}
            {lead.phone && <PanelField label="Phone"><CallLink phone={lead.phone} /></PanelField>}
            {lead.company && <PanelField label="Company">{onOpenCompany && lead.companyId ? <button onClick={() => onOpenCompany(lead.companyId)} className="btn-link" style={{ color: BRAND.blue, background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit' }}>{lead.company}</button> : lead.company}</PanelField>}
            {lead.country && <PanelField label="Country">{lead.country}</PanelField>}
            <PanelField label="Marketing opt-in">{lead.optIn ? 'Yes' : 'No'}</PanelField>
          </PanelSection>

          {(lead.timeline || lead.budget) && (
            <PanelSection title="Enquiry">
              {lead.timeline && <PanelField label="Timeline">{lead.timeline}</PanelField>}
              {lead.budget && <PanelField label="Budget">{lead.budget}</PanelField>}
            </PanelSection>
          )}
          {lead.projectDetails ? (
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.55, background: '#FAFBFC', border: '1px solid ' + BRAND.border, borderRadius: 8, padding: '10px 12px', marginBottom: 16 }}>
              {lead.projectDetails}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 16, fontStyle: 'italic' }}>No message provided{isSpam || lead.status === 'disqualified' ? ' (or purged with the request).' : '.'}</div>
          )}

          {lead.files?.length > 0 && (
            <PanelSection title={`Attachments (${lead.files.length})`}>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 13 }}>
                {lead.files.map((f, i) => (
                  <li key={i} style={{ padding: '5px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <FileText size={13} color={BRAND.muted} />
                    <span>{f.filename}</span>
                    {Number.isFinite(f.sizeBytes) && <span style={{ color: BRAND.muted, fontSize: 11 }}>· {Math.round(f.sizeBytes / 1024)} KB</span>}
                  </li>
                ))}
              </ul>
            </PanelSection>
          )}

          <PanelSection title="Attribution">
            <PanelField label="Channel"><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: CHANNEL_COLORS[lead.channel] || BRAND.muted, marginRight: 6 }} />{prettyChannel(lead.channel)}</PanelField>
            {lead.campaign && <PanelField label="Campaign">{lead.campaign}</PanelField>}
            {lead.keyword && <PanelField label="Keyword">{lead.keyword}</PanelField>}
            {lead.source && <PanelField label="Source">{lead.source}</PanelField>}
            {lead.landingUrl && <PanelField label="Landing page"><a href={lead.landingUrl} target="_blank" rel="noopener noreferrer" style={{ color: BRAND.blue, wordBreak: 'break-all' }}>{lead.landingUrl}</a></PanelField>}
          </PanelSection>

          {lead.dealId && (
            <div style={{ marginTop: 4, padding: 12, border: '1px solid ' + BRAND.border, borderRadius: 8, background: '#F8FAFB' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {stg && <span style={{ background: stg.bg, color: stg.fg, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999 }}>{stg.label}</span>}
                {lead.won && <span style={{ color: '#16A34A', fontWeight: 700, fontSize: 13 }}>{formatGBP(lead.revenue)} won</span>}
                {!lead.won && lead.proposalValue != null && <span style={{ fontSize: 13, color: BRAND.muted }}>Proposal {formatGBP(lead.proposalValue)}</span>}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function PanelSection({ title, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{title}</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>{children}</div>
    </div>
  );
}

function PanelField({ label, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, color: BRAND.ink, wordBreak: 'break-word' }}>{children}</div>
    </div>
  );
}

// ---- Search Console + GA4 ------------------------------------------------

const fmtNum = (n) => (Number(n) || 0).toLocaleString('en-GB');
const fmtPct = (n) => (n == null ? '—' : (Number(n) || 0).toFixed(1) + '%');
const shortDay = (d) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

// Shown when a data source's env vars aren't set yet (data?.configured === false).
function NotConnected({ icon: Icon, title, blurb, onOpenSettings }) {
  return (
    <div style={{ padding: 36, textAlign: 'center', border: '1px dashed ' + BRAND.border, borderRadius: 12 }}>
      <Icon size={26} style={{ color: BRAND.muted, marginBottom: 10 }} />
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, color: BRAND.muted, maxWidth: 420, margin: '0 auto 14px' }}>{blurb}</div>
      <button onClick={onOpenSettings} className="btn-secondary" style={{ padding: '6px 14px' }}>Finish setup →</button>
    </div>
  );
}

// Single-series daily bar chart (clicks / sessions over time).
function DailyBars({ data, dataKey, color }) {
  if (!data || data.length === 0) return null;
  const chartData = data.map((d) => ({ name: shortDay(d.day), value: d[dataKey] }));
  return (
    <div style={{ height: 200, marginBottom: 20, maxWidth: 720 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#EEF1F4" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={24} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={36} />
          <Tooltip formatter={(v) => fmtNum(v)} />
          <Bar dataKey="value" fill={color} radius={[3, 3, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function SearchTab({ data, loading, onOpenSettings, onRetry }) {
  if (loading && !data) return <Loading />;
  if (!data) return <LoadFailed onRetry={onRetry} />;
  if (!data.configured) {
    return <NotConnected icon={Search} title="Connect Google Search Console"
      blurb="See which organic search queries bring people to squideo.com — clicks, impressions, click-through rate and average ranking position."
      onOpenSettings={onOpenSettings} />;
  }
  const t = data.totals || { clicks: 0, impressions: 0, ctr: 0, position: null };
  const queries = data.queries || [];
  return (
    <div>
      {data.lastSync && (
        <div style={{ marginBottom: 16 }}><LastSync status={data.lastSync} /></div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 24 }}>
        <Card label="Clicks" value={fmtNum(t.clicks)} accent={BRAND.blue} />
        <Card label="Impressions" value={fmtNum(t.impressions)} />
        <Card label="CTR" value={fmtPct(t.ctr)} />
        <Card label="Avg position" value={t.position == null ? '—' : t.position.toFixed(1)} sub="lower is better" />
      </div>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>Clicks over time</h2>
      <DailyBars data={data.series} dataKey="clicks" color={BRAND.blue} />
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>Top search queries</h2>
      {queries.length === 0 ? <Empty>No search data for this period yet.</Empty> : (
        <div style={{ overflowX: 'auto', border: '1px solid ' + BRAND.border, borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: BRAND.paper, textAlign: 'left' }}>
                <Th>Query</Th><Th right>Clicks</Th><Th right>Impressions</Th><Th right>CTR</Th><Th right>Avg pos.</Th>
              </tr>
            </thead>
            <tbody>
              {queries.map((q) => (
                <tr key={q.query} style={{ borderTop: '1px solid ' + BRAND.border }}>
                  <Td title={q.query}>{q.query}</Td>
                  <Td right>{fmtNum(q.clicks)}</Td>
                  <Td right>{fmtNum(q.impressions)}</Td>
                  <Td right>{fmtPct(q.ctr)}</Td>
                  <Td right>{q.position == null ? '—' : q.position.toFixed(1)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TrafficTab({ data, loading, onOpenSettings, onRetry }) {
  if (loading && !data) return <Loading />;
  if (!data) return <LoadFailed onRetry={onRetry} />;
  if (!data.configured) {
    return <NotConnected icon={Globe} title="Connect Google Analytics 4"
      blurb="See total site traffic on squideo.com — sessions, users and key events broken down by channel — alongside your own lead numbers."
      onOpenSettings={onOpenSettings} />;
  }
  const t = data.totals || { sessions: 0, users: 0, keyEvents: 0 };
  const channels = data.channels || [];
  return (
    <div>
      {data.lastSync && (
        <div style={{ marginBottom: 16 }}><LastSync status={data.lastSync} /></div>
      )}
      {/* Three metrics → always one row (even on a phone), and compact so they
          don't dwarf the chart below. The four-metric tabs keep the auto-fit
          grid and are allowed to wrap. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, marginBottom: 24 }}>
        <Card label="Sessions" value={fmtNum(t.sessions)} accent={BRAND.blue} compact />
        <Card label="Users" value={fmtNum(t.users)} compact />
        <Card label="Key events" value={fmtNum(t.keyEvents)} sub="GA4 conversions" accent="#16A34A" compact />
      </div>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>Sessions over time</h2>
      <DailyBars data={data.series} dataKey="sessions" color={BRAND.blue} />
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>By channel</h2>
      {channels.length === 0 ? (
        <Empty>
          {data.lastSync && !data.lastSync.ok
            ? <>No traffic yet — the last GA4 sync failed. See the banner above, or check Settings.</>
            : <>No traffic data for this period yet.</>}
        </Empty>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid ' + BRAND.border, borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: BRAND.paper, textAlign: 'left' }}>
                <Th>Channel</Th><Th right>Sessions</Th><Th right>Users</Th><Th right>Key events</Th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.channel} style={{ borderTop: '1px solid ' + BRAND.border }}>
                  <Td>{c.channel}</Td>
                  <Td right>{fmtNum(c.sessions)}</Td>
                  <Td right>{fmtNum(c.users)}</Td>
                  <Td right>{fmtNum(c.keyEvents)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Settings ------------------------------------------------------------

function SettingsTab({ snippet, onSync, onReloadStatus, cutoff, onCutoffChange }) {
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  if (!snippet) return <Loading />;
  const runSync = async () => {
    setSyncing(true); setSyncResult(null);
    const r = await onSync();
    setSyncing(false);
    setSyncResult(r || { ok: false, error: 'No response' });
    // Refresh the persistent "last sync" pills from the just-recorded status so
    // they don't keep showing the stale pre-sync state.
    if (onReloadStatus) onReloadStatus();
  };
  return (
    <div style={{ maxWidth: 760 }}>
      {onCutoffChange && (
        <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 18, marginBottom: 16, boxShadow: CARD_SHADOW }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 6px' }}>Marketing data starts from</h3>
          <p style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 10px' }}>
            Leads before this date are excluded from every lead report — attribution was incomplete
            during the early tracking rollout, so this keeps the channel / CPL / ROAS figures clean.
          </p>
          <input
            type="date"
            value={cutoff || ''}
            onChange={(e) => e.target.value && onCutoffChange(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid ' + BRAND.border, background: 'white', fontSize: 14, color: BRAND.ink }}
          />
        </div>
      )}
      <p style={{ fontSize: 14, color: BRAND.ink, lineHeight: 1.6, marginTop: 0 }}>
        Marketing attribution links every web-form lead back to the ad, keyword and campaign that
        produced it. Two one-time steps capture the data:
      </p>

      <Step n={1} title="Add the tracking snippet to squideo.com">
        <p style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 10px' }}>
          Paste this sitewide on the marketing site (directly in the template, or as a Custom HTML
          tag in Google Tag Manager). It captures the click/UTM data on landing and hands it to the
          quote form.
        </p>
        <CopyBox value={snippet.scriptTag} />
      </Step>

      <Step n={2} title="Add the tracking template to Google Ads">
        <p style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 10px' }}>
          In Google Ads → <strong>Account settings → Tracking → Final URL suffix</strong>, paste the
          string below. This appends the campaign id, keyword and match type to every ad click so we
          can attribute leads to the exact keyword. Keep <strong>auto-tagging on</strong>.
        </p>
        <CopyBox value={snippet.finalUrlSuffix} />
      </Step>

      <Step n={3} title="Connect the Google Ads API (spend & ROAS)">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600,
            color: snippet.adsConfigured ? '#166534' : '#9A3412',
            background: snippet.adsConfigured ? '#DCFCE7' : '#FFF7ED',
            border: '1px solid ' + (snippet.adsConfigured ? '#86EFAC' : '#FED7AA'),
            padding: '4px 10px', borderRadius: 999,
          }}>
            {snippet.adsConfigured ? <Check size={14} /> : <TrendingUp size={14} />}
            {snippet.adsConfigured ? 'Connected' : 'Not connected'}
          </span>
        </div>
        <p style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 14px' }}>
          Spend, cost-per-lead and ROAS appear automatically once the Google Ads API credentials are
          set as environment variables (<code>GOOGLE_ADS_DEVELOPER_TOKEN</code>,{' '}
          <code>GOOGLE_ADS_CLIENT_ID/SECRET</code>, <code>GOOGLE_ADS_REFRESH_TOKEN</code>,{' '}
          <code>GOOGLE_ADS_CUSTOMER_ID</code>, <code>GOOGLE_ADS_LOGIN_CUSTOMER_ID</code>). A daily
          job then syncs the previous days' spend. Lead and revenue attribution work without it.
        </p>

      </Step>

      <Step n={4} title="Connect Search Console + Google Analytics (GA4)">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <StatusPill ok={snippet.gscConfigured} label="Search Console" />
          <StatusPill ok={snippet.ga4Configured} label="Google Analytics 4" />
        </div>
        <p style={{ fontSize: 13, color: BRAND.muted, margin: '0 0 4px' }}>
          These power the <strong>Search</strong> and <strong>Traffic</strong> tabs. They reuse the same
          Google OAuth client as Ads — add a refresh token granted the <code>analytics.readonly</code>{' '}
          and <code>webmasters.readonly</code> scopes (<code>GOOGLE_OAUTH_REFRESH_TOKEN</code>), plus{' '}
          <code>GA4_PROPERTY_ID</code> and <code>GSC_SITE_URL</code>. A daily job then syncs the data.
        </p>
      </Step>

      {(snippet.adsConfigured || snippet.gscConfigured || snippet.ga4Configured) && (
        <div style={{ borderTop: '1px solid ' + BRAND.border, paddingTop: 16, marginTop: 4 }}>
          <button
            onClick={runSync}
            disabled={syncing}
            className="btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, opacity: syncing ? 0.6 : 1 }}
          >
            <RefreshCw size={15} style={syncing ? { animation: 'spin 1s linear infinite' } : undefined} />
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
          <span style={{ fontSize: 12, color: BRAND.muted, marginLeft: 10 }}>
            Pulls the latest Ads spend, Search Console and GA4 data. Syncs automatically every day at 6am.
          </span>
          {snippet.lastSync && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
              {snippet.ga4Configured && <LastSync status={snippet.lastSync.ga4} name="GA4" />}
              {snippet.gscConfigured && <LastSync status={snippet.lastSync.gsc} name="Search Console" />}
              {snippet.adsConfigured && <LastSync status={snippet.lastSync.ads} name="Google Ads" />}
            </div>
          )}
          {syncResult && <SyncResult result={syncResult} />}
        </div>
      )}
    </div>
  );
}

function StatusPill({ ok, label }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600,
      color: ok ? '#166534' : '#9A3412', background: ok ? '#DCFCE7' : '#FFF7ED',
      border: '1px solid ' + (ok ? '#86EFAC' : '#FED7AA'), padding: '4px 10px', borderRadius: 999,
    }}>
      {ok ? <Check size={14} /> : <TrendingUp size={14} />} {label}: {ok ? 'Connected' : 'Not connected'}
    </span>
  );
}

// Per-source result lines from POST /analytics/sync → { ads, gsc, ga4 }. A source
// that isn't configured is skipped (no line); the rest show success or error.
function SyncResult({ result }) {
  const describe = (name, r) => {
    if (!r || r.skipped) return null;
    if (r.ok) {
      let detail = 'synced ✓';
      if (name === 'Ads' && r.keywordRows != null) detail = `synced ✓ — ${r.keywordRows} keyword, ${r.campaignRows} campaign rows`;
      else if (name === 'Search Console' && r.queryRows != null) detail = `synced ✓ — ${r.queryRows} query rows`;
      else if (name === 'GA4' && r.rows != null) detail = `synced ✓ — ${r.rows} rows`;
      return { name, ok: true, detail };
    }
    return { name, ok: false, detail: r.error || 'failed' };
  };
  const lines = [describe('Ads', result.ads), describe('Search Console', result.gsc), describe('GA4', result.ga4)].filter(Boolean);
  if (!lines.length) {
    // No per-source lines means either nothing is connected, or the POST itself
    // failed (non-2xx / timeout) and came back as a bare { ok:false, error } with
    // no ads/gsc/ga4 keys. Surface that instead of silently rendering nothing.
    lines.push(result?.error
      ? { name: 'Sync failed', ok: false, detail: result.error }
      : { name: 'Sync', ok: true, detail: 'Nothing to sync — no data sources are connected.' });
  }
  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {lines.map((l) => (
        <div key={l.name} style={{
          padding: '8px 12px', borderRadius: 8, fontSize: 13,
          background: l.ok ? '#DCFCE7' : '#FEE2E2', border: '1px solid ' + (l.ok ? '#86EFAC' : '#FCA5A5'),
          color: l.ok ? '#166534' : '#991B1B',
        }}>
          <strong>{l.name}:</strong> {l.detail}
        </div>
      ))}
    </div>
  );
}

function Step({ n, title, children }) {
  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 18, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ width: 24, height: 24, borderRadius: '50%', background: BRAND.blue, color: 'white', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700 }}>{n}</span>
        <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{title}</h3>
      </div>
      {children}
    </div>
  );
}

function CopyBox({ value }) {
  const [copied, setCopied] = useState(false);
  const tRef = useRef(null);
  const copy = () => {
    try { navigator.clipboard.writeText(value); setCopied(true); clearTimeout(tRef.current); tRef.current = setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard blocked */ }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
      <code style={{ flex: 1, background: '#0F2A3D', color: '#D7E3EC', padding: '10px 12px', borderRadius: 8, fontSize: 12, overflowX: 'auto', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, Menlo, monospace' }}>{value}</code>
      <button onClick={copy} className="btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
        {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

// ---- table cells ---------------------------------------------------------

function Th({ children, right, clickable, onClick }) {
  return (
    <th onClick={onClick} style={{ padding: '10px 14px', fontSize: 12, fontWeight: 600, color: BRAND.muted, textAlign: right ? 'right' : 'left', whiteSpace: 'nowrap', cursor: clickable ? 'pointer' : 'default', userSelect: 'none' }}>{children}</th>
  );
}
function Td({ children, right, title }) {
  return (
    <td title={title} style={{ padding: '10px 14px', textAlign: right ? 'right' : 'left', color: BRAND.ink, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{children}</td>
  );
}
