import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from 'recharts';
import { ArrowLeft, BarChart3, MailQuestion, LayoutDashboard, Megaphone, Check, Copy, TrendingUp, RefreshCw, Search, Globe, Users, UserCheck, FileText, Trophy, PoundSterling, Wallet, Target, Coins, Clock, Gauge, XCircle } from 'lucide-react';
import { BRAND, APP_MAX_WIDTH } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, useIsMobile } from '../../utils.js';

// Remembers the Marketing page's view state across navigation (mirrors
// financeViewMemory): the active tab, report grouping, date range and scroll.
const marketingViewMemory = { section: 'overview', groupBy: 'campaign', range: { mode: 'preset', days: 90 }, scrollY: 0 };

const CHANNEL_LABELS = {
  paid_search: 'Paid search',
  organic: 'Organic',
  social: 'Social',
  referral: 'Referral',
  direct: 'Direct',
};
const CHANNEL_COLORS = {
  paid_search: '#2BB8E6',
  organic: '#16A34A',
  social: '#7C3AED',
  referral: '#F59E0B',
  direct: '#94A3B8',
};
const prettyChannel = (c) => CHANNEL_LABELS[c] || c || '—';

const RANGE_PRESETS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '12 months' },
];

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

const dateStr = (d) => d.toISOString().slice(0, 10);
function rangeFor(days) {
  const now = new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - (days - 1) * 86400000);
  return { from: dateStr(from), to: dateStr(to) };
}

// ---- Date-range model: preset (rolling window) | month | custom from–to -----
function thisMonthStr() {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}`;
}
function shiftMonth(monthStr, delta) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, (m - 1) + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthRange(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this one
  return { from: dateStr(from), to: dateStr(to) };
}
// Resolve a range descriptor to inclusive { from, to } date strings for the API.
function computeRange(range) {
  if (range?.mode === 'month' && range.month) return monthRange(range.month);
  if (range?.mode === 'custom' && range.from && range.to) {
    return range.from <= range.to ? { from: range.from, to: range.to } : { from: range.to, to: range.from };
  }
  return rangeFor(range?.days || 90);
}
const pct = (n) => (n == null ? '—' : (Number(n) || 0).toFixed(1) + '%');
const dash = (v, fmt) => (v == null ? '—' : fmt(v));
const fmtRoas = (v) => (v == null ? '—' : (Number(v) || 0).toFixed(2) + '×');

export function MarketingView({ section: sectionProp, onBack, onOpenDeal, onOpenCompany }) {
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

      {section === 'overview' && <OverviewTab data={overview} loading={loading} adsConfigured={adsConfigured} onOpenSettings={() => setSection('settings')} onRetry={() => setReload((n) => n + 1)} isMobile={isMobile} />}
      {section === 'reports' && (
        <ReportsTab
          data={report} loading={loading} groupBy={groupBy} setGroupBy={setGroupBy} adsConfigured={adsConfigured}
          onRetry={() => setReload((n) => n + 1)}
        />
      )}
      {section === 'leads' && <LeadsTab data={leads} loading={loading} onOpenDeal={onOpenDeal} onOpenCompany={onOpenCompany} onRetry={() => setReload((n) => n + 1)} />}
      {section === 'search' && <SearchTab data={search} loading={loading} onOpenSettings={() => setSection('settings')} onRetry={() => setReload((n) => n + 1)} />}
      {section === 'traffic' && <TrafficTab data={traffic} loading={loading} onOpenSettings={() => setSection('settings')} onRetry={() => setReload((n) => n + 1)} />}
      {section === 'settings' && <SettingsTab snippet={snippet} onSync={() => actions.syncAdSpend()} cutoff={cutoff} onCutoffChange={onCutoffChange} />}
    </div>
  );
}

// ---- shared bits ---------------------------------------------------------

const segBtn = (active) => ({
  padding: '5px 12px', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13,
  fontWeight: active ? 600 : 500, color: active ? 'white' : BRAND.ink,
  background: active ? BRAND.blue : 'transparent',
});

// Date-range picker: rolling-window presets, a month stepper (this month +
// previous months via ‹ ›/the month picker), and a custom from–to range.
function RangeControl({ range, setRange }) {
  const tm = thisMonthStr();
  const month = range.mode === 'month' ? range.month : tm;
  const atCurrentMonth = month >= tm;
  const monthActive = range.mode === 'month';
  const customActive = range.mode === 'custom';
  const dateInput = {
    padding: '4px 7px', borderRadius: 7, border: '1px solid ' + BRAND.border,
    background: 'white', fontSize: 13, color: BRAND.ink,
  };
  const arrowBtn = (disabled) => ({
    border: 'none', background: 'transparent', cursor: disabled ? 'default' : 'pointer',
    color: disabled ? BRAND.border : BRAND.ink, fontSize: 16, lineHeight: 1, padding: '2px 6px', borderRadius: 6,
  });
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {/* rolling-window presets */}
      <div style={{ display: 'inline-flex', gap: 2, background: BRAND.paper, borderRadius: 8, padding: 2 }}>
        {RANGE_PRESETS.map((r) => (
          <button key={r.days} onClick={() => setRange({ mode: 'preset', days: r.days })} style={segBtn(range.mode === 'preset' && range.days === r.days)}>{r.label}</button>
        ))}
      </div>

      {/* month stepper */}
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 1, background: BRAND.paper, borderRadius: 8, padding: 2,
        border: '1px solid ' + (monthActive ? BRAND.blue : 'transparent'),
      }}>
        <button title="Previous month" style={arrowBtn(false)} onClick={() => setRange({ mode: 'month', month: shiftMonth(month, -1) })}>‹</button>
        <input
          type="month" value={month} max={tm}
          onClick={() => { if (!monthActive) setRange({ mode: 'month', month: tm }); }}
          onChange={(e) => e.target.value && setRange({ mode: 'month', month: e.target.value })}
          style={{ border: 'none', background: 'transparent', fontSize: 13, fontWeight: monthActive ? 700 : 500, color: monthActive ? BRAND.blue : BRAND.ink, padding: '3px 2px', cursor: 'pointer' }}
        />
        <button title="Next month" disabled={atCurrentMonth} style={arrowBtn(atCurrentMonth)} onClick={() => { if (!atCurrentMonth) setRange({ mode: 'month', month: shiftMonth(month, 1) }); }}>›</button>
      </div>

      {/* custom from–to */}
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, background: BRAND.paper, borderRadius: 8, padding: '2px 6px',
        border: '1px solid ' + (customActive ? BRAND.blue : 'transparent'),
      }}>
        <input
          type="date" value={customActive ? range.from : ''} max={customActive ? range.to : undefined}
          onChange={(e) => { const v = e.target.value; if (v) setRange({ mode: 'custom', from: v, to: customActive && range.to ? range.to : v }); }}
          style={dateInput}
        />
        <span style={{ color: BRAND.muted }}>–</span>
        <input
          type="date" value={customActive ? range.to : ''} min={customActive ? range.from : undefined}
          onChange={(e) => { const v = e.target.value; if (v) setRange({ mode: 'custom', from: customActive && range.from ? range.from : v, to: v }); }}
          style={dateInput}
        />
      </div>
    </div>
  );
}

function Card({ label, value, sub, accent }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: '16px 18px', minWidth: 0 }}>
      <div style={{ fontSize: 12, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 6, color: accent || BRAND.ink }}>{value}</div>
      {sub != null && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>{sub}</div>}
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
  return (
    <div style={{
      background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 14, boxShadow: CARD_SHADOW,
      padding: big ? '18px 20px' : '15px 16px', display: 'flex', gap: 13, alignItems: 'flex-start', minWidth: 0,
    }}>
      <div style={{
        width: big ? 42 : 38, height: big ? 42 : 38, borderRadius: 11, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: accent + '1A', color: accent,
      }}>
        <Icon size={big ? 21 : 19} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11.5, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
        <div style={{ fontSize: big ? 28 : 23, fontWeight: 700, marginTop: 3, lineHeight: 1.1, color: colorValue ? accent : BRAND.ink, overflowWrap: 'anywhere' }}>{value}</div>
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
            <StatCard icon={PoundSterling} label="Revenue" value={formatGBP(t.revenue)} sub="signed value" accent="#16A34A" big />
            <StatCard icon={FileText} label="Proposal value" value={formatGBP(t.proposalValueSent)} sub="sent in period" accent="#0EA5E9" />
            <StatCard icon={Clock} label="Avg lead→sale" value={t.avgLeadToSaleDays == null ? '—' : t.avgLeadToSaleDays + ' days'} accent="#7C3AED" />
          </div>
        </div>
      </div>

      {/* Spend, efficiency & quality */}
      <SectionLabel>Spend, efficiency &amp; quality</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))', gap: 12, marginBottom: 26 }}>
        <StatCard icon={Wallet} label="Ad spend" value={dash(t.spend, formatGBP)} accent="#F59E0B" />
        <StatCard icon={Target} label="Cost / lead" value={dash(t.costPerLead, formatGBP)} accent="#F59E0B" />
        <StatCard icon={Coins} label="Cost / sale" value={dash(t.costPerSale, formatGBP)} accent="#F59E0B" />
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

function LeadsTab({ data, loading, onOpenDeal, onRetry }) {
  const [filter, setFilter] = useState('all'); // all | new | qualified | disqualified
  if (loading && !data) return <Loading />;
  if (!data) return <LoadFailed onRetry={onRetry} />;
  const allLeads = data?.leads || [];
  if (allLeads.length === 0) return <Empty>No leads captured in this period yet.</Empty>;
  const counts = {
    all: allLeads.length,
    new: allLeads.filter((l) => (l.status || 'new') === 'new').length,
    qualified: allLeads.filter((l) => l.status === 'qualified').length,
    disqualified: allLeads.filter((l) => l.status === 'disqualified').length,
  };
  const FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'new', label: 'New' },
    { key: 'qualified', label: 'Qualified' },
    { key: 'disqualified', label: 'Disqualified' },
  ];
  const leads = filter === 'all' ? allLeads : allLeads.filter((l) => (l.status || 'new') === filter);
  return (
    <div>
      <div style={{ display: 'inline-flex', gap: 2, background: BRAND.paper, borderRadius: 8, padding: 2, marginBottom: 16, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => setFilter(f.key)} style={segBtn(filter === f.key)}>
            {f.label} <span style={{ opacity: 0.7 }}>{counts[f.key]}</span>
          </button>
        ))}
      </div>
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
            const clickable = !!l.dealId && !!onOpenDeal;
            return (
              <tr
                key={l.id}
                onClick={clickable ? () => onOpenDeal(l.dealId) : undefined}
                style={{ borderTop: '1px solid ' + BRAND.border, cursor: clickable ? 'pointer' : 'default' }}
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 24 }}>
        <Card label="Sessions" value={fmtNum(t.sessions)} accent={BRAND.blue} />
        <Card label="Users" value={fmtNum(t.users)} />
        <Card label="Key events" value={fmtNum(t.keyEvents)} sub="GA4 conversions" accent="#16A34A" />
      </div>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>Sessions over time</h2>
      <DailyBars data={data.series} dataKey="sessions" color={BRAND.blue} />
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>By channel</h2>
      {channels.length === 0 ? <Empty>No traffic data for this period yet.</Empty> : (
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

function SettingsTab({ snippet, onSync, cutoff, onCutoffChange }) {
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  if (!snippet) return <Loading />;
  const runSync = async () => {
    setSyncing(true); setSyncResult(null);
    const r = await onSync();
    setSyncing(false);
    setSyncResult(r || { ok: false, error: 'No response' });
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
  if (!lines.length) return null;
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
