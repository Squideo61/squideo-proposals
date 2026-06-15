import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from 'recharts';
import { ArrowLeft, BarChart3, MailQuestion, LayoutDashboard, Megaphone, Check, Copy, TrendingUp, RefreshCw } from 'lucide-react';
import { BRAND, APP_MAX_WIDTH } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, useIsMobile } from '../../utils.js';

// Remembers the Marketing page's view state across navigation (mirrors
// financeViewMemory): the active tab, report grouping, date range and scroll.
const marketingViewMemory = { section: 'overview', groupBy: 'campaign', rangeDays: 90, scrollY: 0 };

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
  { key: 'settings', label: 'Settings', icon: Megaphone },
];

const dateStr = (d) => d.toISOString().slice(0, 10);
function rangeFor(days) {
  const now = new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - (days - 1) * 86400000);
  return { from: dateStr(from), to: dateStr(to) };
}
const pct = (n) => (n == null ? '—' : (Number(n) || 0).toFixed(1) + '%');
const dash = (v, fmt) => (v == null ? '—' : fmt(v));
const fmtRoas = (v) => (v == null ? '—' : (Number(v) || 0).toFixed(2) + '×');

export function MarketingView({ section: sectionProp, onBack, onOpenDeal, onOpenCompany }) {
  const { actions } = useStore();
  const isMobile = useIsMobile();
  const [section, setSection] = useState(sectionProp || marketingViewMemory.section);
  const [rangeDays, setRangeDays] = useState(marketingViewMemory.rangeDays);
  const [groupBy, setGroupBy] = useState(marketingViewMemory.groupBy);

  const [overview, setOverview] = useState(null);   // reports grouped by channel
  const [report, setReport] = useState(null);       // reports grouped by groupBy
  const [leads, setLeads] = useState(null);
  const [snippet, setSnippet] = useState(null);
  const [loading, setLoading] = useState(false);

  // Follow the section coming from the header (navigate('marketing', <section>)).
  useEffect(() => { if (sectionProp) setSection(sectionProp); }, [sectionProp]);
  useEffect(() => { marketingViewMemory.section = section; }, [section]);
  useEffect(() => { marketingViewMemory.rangeDays = rangeDays; }, [rangeDays]);
  useEffect(() => { marketingViewMemory.groupBy = groupBy; }, [groupBy]);

  const { from, to } = useMemo(() => rangeFor(rangeDays), [rangeDays]);

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
  }, [section, from, to, actions]);

  useEffect(() => {
    if (section !== 'reports') return;
    let active = true;
    setLoading(true);
    actions.loadMarketingReports(groupBy, from, to)
      .then((d) => { if (active) setReport(d); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [section, groupBy, from, to, actions]);

  useEffect(() => {
    if (section !== 'leads') return;
    let active = true;
    setLoading(true);
    actions.loadMarketingLeads(from, to)
      .then((d) => { if (active) setLeads(d); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [section, from, to, actions]);

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
        {section !== 'settings' && (
          <div style={{ display: 'inline-flex', gap: 2, background: BRAND.paper, borderRadius: 8, padding: 2 }}>
            {RANGE_PRESETS.map((r) => (
              <button
                key={r.days}
                onClick={() => setRangeDays(r.days)}
                style={segBtn(rangeDays === r.days)}
              >{r.label}</button>
            ))}
          </div>
        )}
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

      {section === 'overview' && <OverviewTab data={overview} loading={loading} adsConfigured={adsConfigured} onOpenSettings={() => setSection('settings')} />}
      {section === 'reports' && (
        <ReportsTab
          data={report} loading={loading} groupBy={groupBy} setGroupBy={setGroupBy} adsConfigured={adsConfigured}
        />
      )}
      {section === 'leads' && <LeadsTab data={leads} loading={loading} onOpenDeal={onOpenDeal} onOpenCompany={onOpenCompany} />}
      {section === 'settings' && <SettingsTab snippet={snippet} onSync={() => actions.syncAdSpend()} />}
    </div>
  );
}

// ---- shared bits ---------------------------------------------------------

const segBtn = (active) => ({
  padding: '5px 12px', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13,
  fontWeight: active ? 600 : 500, color: active ? 'white' : BRAND.ink,
  background: active ? BRAND.blue : 'transparent',
});

function Card({ label, value, sub, accent }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: '16px 18px', minWidth: 0 }}>
      <div style={{ fontSize: 12, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 6, color: accent || BRAND.ink }}>{value}</div>
      {sub != null && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Loading() {
  return <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted }}>Loading…</div>;
}
function Empty({ children }) {
  return <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted, border: '1px dashed ' + BRAND.border, borderRadius: 12 }}>{children}</div>;
}

// ---- Dashboard -----------------------------------------------------------

function OverviewTab({ data, loading, adsConfigured, onOpenSettings }) {
  if (loading && !data) return <Loading />;
  const t = data?.totals || { leads: 0, qualified: 0, won: 0, revenue: 0, spend: null, roas: null, costPerLead: null, conversionRate: 0 };
  const channels = (data?.rows || []).slice().sort((a, b) => b.leads - a.leads);
  const chartData = channels.map((r) => ({ name: prettyChannel(r.key), leads: r.leads, revenue: r.revenue, key: r.key }));

  return (
    <div>
      {!adsConfigured && (
        <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 10, padding: '10px 14px', marginBottom: 18, fontSize: 13, color: '#9A3412', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Megaphone size={15} />
          <span>Connect Google Ads to see spend, cost-per-lead and ROAS.</span>
          <button onClick={onOpenSettings} className="btn-link" style={{ fontWeight: 600 }}>Finish setup →</button>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 24 }}>
        <Card label="Leads" value={t.leads} />
        <Card label="Qualified" value={t.qualified} sub={t.leads ? Math.round((t.qualified / t.leads) * 100) + '% of leads' : null} />
        <Card label="Won" value={t.won} sub={pct(t.conversionRate) + ' conversion'} accent="#16A34A" />
        <Card label="Revenue" value={formatGBP(t.revenue)} accent="#16A34A" />
        <Card label="Ad spend" value={dash(t.spend, formatGBP)} />
        <Card label="Cost / lead" value={dash(t.costPerLead, formatGBP)} />
        <Card label="ROAS" value={fmtRoas(t.roas)} accent={t.roas != null && t.roas >= 1 ? '#16A34A' : undefined} />
      </div>

      <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>By channel</h2>
      {channels.length === 0 ? <Empty>No leads in this period yet.</Empty> : (
        <>
          <div style={{ height: 240, marginBottom: 16 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#EEF1F4" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v, n) => (n === 'revenue' ? formatGBP(v) : v)} />
                <Bar dataKey="leads" name="Leads" radius={[4, 4, 0, 0]}>
                  {chartData.map((d) => <Cell key={d.key} fill={CHANNEL_COLORS[d.key] || BRAND.blue} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <ChannelTable rows={channels} adsConfigured={adsConfigured} />
        </>
      )}
    </div>
  );
}

function ChannelTable({ rows, adsConfigured }) {
  return (
    <div style={{ overflowX: 'auto', border: '1px solid ' + BRAND.border, borderRadius: 12 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: BRAND.paper, textAlign: 'left' }}>
            <Th>Channel</Th><Th right>Leads</Th><Th right>Won</Th><Th right>Revenue</Th>
            {adsConfigured && <><Th right>Spend</Th><Th right>Cost/lead</Th><Th right>ROAS</Th></>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} style={{ borderTop: '1px solid ' + BRAND.border }}>
              <Td><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: CHANNEL_COLORS[r.key] || BRAND.muted, marginRight: 8 }} />{prettyChannel(r.key)}</Td>
              <Td right>{r.leads}</Td>
              <Td right>{r.won}</Td>
              <Td right>{formatGBP(r.revenue)}</Td>
              {adsConfigured && <><Td right>{dash(r.spend, formatGBP)}</Td><Td right>{dash(r.costPerLead, formatGBP)}</Td><Td right>{fmtRoas(r.roas)}</Td></>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Reports -------------------------------------------------------------

function ReportsTab({ data, loading, groupBy, setGroupBy, adsConfigured }) {
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
      {loading && !data ? <Loading /> : rows.length === 0 ? <Empty>No leads in this period yet.</Empty> : (
        <div style={{ overflowX: 'auto', border: '1px solid ' + BRAND.border, borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: BRAND.paper, textAlign: 'left' }}>
                <Th onClick={() => sortBy('label')} clickable>{GROUP_OPTIONS.find((g) => g.key === groupBy)?.label}{arrow('label')}</Th>
                <Th right onClick={() => sortBy('leads')} clickable>Leads{arrow('leads')}</Th>
                <Th right onClick={() => sortBy('qualified')} clickable>Qualified{arrow('qualified')}</Th>
                <Th right onClick={() => sortBy('won')} clickable>Won{arrow('won')}</Th>
                <Th right onClick={() => sortBy('conversionRate')} clickable>Conv.{arrow('conversionRate')}</Th>
                <Th right onClick={() => sortBy('revenue')} clickable>Revenue{arrow('revenue')}</Th>
                {adsConfigured && <>
                  <Th right onClick={() => sortBy('spend')} clickable>Spend{arrow('spend')}</Th>
                  <Th right onClick={() => sortBy('costPerLead')} clickable>Cost/lead{arrow('costPerLead')}</Th>
                  <Th right onClick={() => sortBy('roas')} clickable>ROAS{arrow('roas')}</Th>
                </>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} style={{ borderTop: '1px solid ' + BRAND.border }}>
                  <Td title={r.label}>{groupBy === 'channel' ? prettyChannel(r.key) : (r.label || '—')}</Td>
                  <Td right>{r.leads}</Td>
                  <Td right>{r.qualified}</Td>
                  <Td right>{r.won}</Td>
                  <Td right>{pct(r.conversionRate)}</Td>
                  <Td right>{formatGBP(r.revenue)}</Td>
                  {adsConfigured && <><Td right>{dash(r.spend, formatGBP)}</Td><Td right>{dash(r.costPerLead, formatGBP)}</Td><Td right>{fmtRoas(r.roas)}</Td></>}
                </tr>
              ))}
            </tbody>
            {data?.totals && (
              <tfoot>
                <tr style={{ borderTop: '2px solid ' + BRAND.border, fontWeight: 700, background: BRAND.paper }}>
                  <Td>Total</Td>
                  <Td right>{data.totals.leads}</Td>
                  <Td right>{data.totals.qualified}</Td>
                  <Td right>{data.totals.won}</Td>
                  <Td right>{pct(data.totals.conversionRate)}</Td>
                  <Td right>{formatGBP(data.totals.revenue)}</Td>
                  {adsConfigured && <><Td right>{dash(data.totals.spend, formatGBP)}</Td><Td right>{dash(data.totals.costPerLead, formatGBP)}</Td><Td right>{fmtRoas(data.totals.roas)}</Td></>}
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

function LeadsTab({ data, loading, onOpenDeal }) {
  if (loading && !data) return <Loading />;
  const leads = data?.leads || [];
  if (leads.length === 0) return <Empty>No leads captured in this period yet.</Empty>;
  return (
    <div style={{ overflowX: 'auto', border: '1px solid ' + BRAND.border, borderRadius: 12 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: BRAND.paper, textAlign: 'left' }}>
            <Th>Date</Th><Th>Lead</Th><Th>Channel</Th><Th>Campaign</Th><Th>Keyword</Th><Th>Status</Th><Th right>Revenue</Th>
          </tr>
        </thead>
        <tbody>
          {leads.map((l) => {
            const st = STATUS_STYLE[l.status] || STATUS_STYLE.new;
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
                <Td right>{l.won ? <span style={{ color: '#16A34A', fontWeight: 600 }}>{formatGBP(l.revenue)}</span> : <span style={{ color: BRAND.muted }}>—</span>}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- Settings ------------------------------------------------------------

function SettingsTab({ snippet, onSync }) {
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

        {snippet.adsConfigured && (
          <div>
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
              Pulls the last 14 days of spend from Google Ads.
            </span>
            {syncResult && (
              <div style={{
                marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 13,
                background: syncResult.ok ? '#DCFCE7' : '#FEE2E2',
                border: '1px solid ' + (syncResult.ok ? '#86EFAC' : '#FCA5A5'),
                color: syncResult.ok ? '#166534' : '#991B1B',
              }}>
                {syncResult.ok
                  ? `Synced ✓ — pulled ${syncResult.keywordRows ?? 0} keyword rows and ${syncResult.campaignRows ?? 0} campaign rows. Open Reports to see spend & ROAS.`
                  : `Sync failed: ${syncResult.error || 'unknown error'}`}
              </div>
            )}
          </div>
        )}
      </Step>
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
