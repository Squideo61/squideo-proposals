import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Wallet, TrendingUp, PoundSterling, Landmark, Coins, KanbanSquare, Clapperboard,
  CheckSquare, MailQuestion, Layers, ArrowUpRight, PiggyBank, Sparkles, Gauge,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  AreaChart, Area,
} from 'recharts';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, useIsMobile } from '../../utils.js';
import { permissionsInclude } from '../../lib/permissions.js';
import { PIPELINE_STAGES } from '../../lib/stages.js';
import { PRODUCTION_PHASES } from '../../lib/productionStages.js';

// ── Business Overview — the "mission control" page. Pulls the whole business
// onto one screen: money (finance-gated), sales pipeline, production status,
// pending payments, tasks/quote-requests and partners. Finance figures only
// render for finance.manage users (the /api/crm/stats/* route 403s otherwise);
// everyone else still sees the operational tiles. Data comes from existing
// store load actions fired in parallel on mount — no dedicated endpoint. ──

const GREEN = '#10B981';
const AMBER = '#F59E0B';
const TEAL = '#0E7490';
const PURPLE = '#7C3AED';

const gbp0 = (n) => '£' + Math.round(Number(n) || 0).toLocaleString('en-GB');
const gbpK = (v) => '£' + Math.round((Number(v) || 0) / 1000) + 'k';
const shortMonth = (key) => {
  const [y, m] = String(key).split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'short' });
};
const sumNet = (days) => (Array.isArray(days) ? days.reduce((s, d) => s + (Number(d.net) || 0), 0) : 0);
const daysAgoLabel = (iso) => {
  if (!iso) return '';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
};

// Count weekdays left in the current month (today inclusive) — a rough pace
// denominator. Bank holidays aren't subtracted (kept simple); good enough for a
// glanceable "days left" hint.
function workingDaysLeftInMonth() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  let n = 0;
  for (let day = now.getDate(); day <= end; day++) {
    const dow = new Date(now.getFullYear(), now.getMonth(), day).getDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

// rAF count-up — animates 0 → target with an ease-out curve. Re-runs when the
// target changes so figures "land" once their data loads.
function useCountUp(target, duration = 900) {
  const [val, setVal] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    const to = Number(target) || 0;
    if (from === to) { setVal(to); return; }
    let raf;
    const start = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(from + (to - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

const riseStyle = (i) => ({ animation: 'bo-rise 480ms cubic-bezier(.22,1,.36,1) both', animationDelay: `${i * 55}ms` });

// Lift-on-hover wrapper used by every clickable tile.
function liftHandlers(e, on) {
  e.currentTarget.style.transform = on ? 'translateY(-2px)' : 'translateY(0)';
  e.currentTarget.style.boxShadow = on ? '0 8px 20px rgba(15,42,61,0.10)' : '0 1px 2px rgba(15,42,61,0.04)';
}

// Headline metric tile (StatCard pattern from FinanceView) with a count-up value
// and optional sparkline / click-through.
function KpiCard({ icon: Icon, label, value, format = gbp0, sub, accent, onClick, spark, delay = 0 }) {
  const animated = useCountUp(value);
  const clickable = !!onClick;
  const sparkId = 'spark-' + String(label).replace(/[^a-zA-Z0-9]/g, '');
  return (
    <div
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      onMouseEnter={clickable ? (e) => liftHandlers(e, true) : undefined}
      onMouseLeave={clickable ? (e) => liftHandlers(e, false) : undefined}
      style={{
        background: 'white', border: '1px solid ' + BRAND.border, borderLeft: `3px solid ${accent || BRAND.blue}`,
        borderRadius: 12, padding: 16, cursor: clickable ? 'pointer' : 'default',
        boxShadow: '0 1px 2px rgba(15,42,61,0.04)', transition: 'transform 140ms ease, box-shadow 140ms ease',
        ...riseStyle(delay),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
        {Icon && <Icon size={14} color={accent || BRAND.muted} />}
        <span style={{ flex: 1 }}>{label}</span>
        {clickable && <ArrowUpRight size={14} color={BRAND.muted} style={{ opacity: 0.5 }} />}
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, color: BRAND.ink, letterSpacing: -0.5 }}>{format(animated)}</div>
      {sub && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>{sub}</div>}
      {spark && spark.length > 1 && (
        <div style={{ height: 34, margin: '8px -4px -4px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={spark} margin={{ top: 4, right: 2, left: 2, bottom: 0 }}>
              <defs>
                <linearGradient id={sparkId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={accent || BRAND.blue} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={accent || BRAND.blue} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="v" stroke={accent || BRAND.blue} strokeWidth={2} fill={`url(#${sparkId})`} dot={false} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// Animated SVG progress ring (no dependency).
function ProgressRing({ value, max, size = 132, stroke = 12, color = BRAND.blue }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const animated = useCountUp(Math.round(pct * 100));
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#EEF1F4" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)}
          style={{ transition: 'stroke-dashoffset 900ms cubic-bezier(.22,1,.36,1)' }}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: BRAND.ink }}>{Math.round(animated)}%</div>
        <div style={{ fontSize: 10, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>of target</div>
      </div>
    </div>
  );
}

// A panel shell with an uppercase section heading + optional "open" affordance.
function Panel({ title, icon: Icon, onOpen, children, delay = 0, pad = 18 }) {
  return (
    <section
      style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 14, padding: pad, ...riseStyle(delay) }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        {Icon && <Icon size={16} color={BRAND.blue} />}
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: BRAND.ink, textTransform: 'uppercase', letterSpacing: 0.6, flex: 1 }}>{title}</h3>
        {onOpen && (
          <button onClick={onOpen} className="btn-link" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Open <ArrowUpRight size={13} />
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

// A small stat with a coloured dot — used for pipeline / production breakdowns.
function StageBar({ items, onOpen }) {
  const total = items.reduce((s, it) => s + it.count, 0) || 1;
  return (
    <div>
      <div style={{ display: 'flex', height: 12, borderRadius: 999, overflow: 'hidden', background: '#EEF1F4', marginBottom: 14 }}>
        {items.filter((it) => it.count > 0).map((it) => (
          <div key={it.id} title={`${it.label}: ${it.count}`} style={{ width: `${(it.count / total) * 100}%`, background: it.color }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {items.map((it) => (
          <button
            key={it.id}
            onClick={onOpen}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 11px', borderRadius: 999,
              border: '1px solid ' + BRAND.border, background: 'white', cursor: 'pointer', fontSize: 13, color: BRAND.ink,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.paper; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'white'; }}
          >
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: it.color }} />
            <span style={{ fontWeight: 500 }}>{it.label}</span>
            <span style={{ fontWeight: 800 }}>{it.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function BusinessOverviewView({
  onOpenFinance, onOpenPipeline, onOpenProduction, onOpenProjects, onOpenTasks,
  onOpenQuoteRequests, onOpenPartners, onOpenDeal, onOpenVideo, onOpenPartner,
}) {
  const { state, actions } = useStore();
  const isMobile = useIsMobile();
  const perms = state.session?.permissions;
  const canBusiness = permissionsInclude(perms, 'finance.manage');
  const canProduction = permissionsInclude(perms, 'production.access');

  const now = new Date();
  const year = now.getFullYear();
  const monthKey = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthName = now.toLocaleString('en-GB', { month: 'long' });
  const greeting = (() => {
    const h = now.getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  })();
  const firstName = (state.session?.name || '').split(' ')[0];

  // Parallel mount load. Finance/stats actions only fire for finance.manage
  // users (they'd 403 otherwise); productionVideos + partner credits are needed
  // for everyone. Deals, tasks, companies and quoteRequests are already in state
  // from the app bootstrap.
  useEffect(() => {
    actions.fetchPartnerCreditsList();
    if (canProduction) actions.loadProductionVideos();
    if (canBusiness) {
      actions.loadFinanceStats(year);
      actions.loadPerformanceStats(monthKey);
      actions.loadSalesStats(monthKey);
      if (!state.trend) actions.loadTrend(36);
      actions.loadPendingPayments();
      actions.loadCashflowTargets();
    }
  }, [actions, canBusiness, canProduction, year, monthKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Finance-gated slices (guarded against a stale period the Finance page may
  // have left behind). ──
  const perf = canBusiness && state.performanceStats?.period === monthKey ? state.performanceStats : null;
  const sales = canBusiness && state.salesStats?.period === monthKey ? state.salesStats : null;
  const fin = canBusiness && state.financeStats?.year === year ? state.financeStats : null;
  const pending = canBusiness ? state.pendingPayments : null;
  const trend = canBusiness ? state.trend : null;
  const cashflowTargets = canBusiness ? state.cashflowTargets : null;

  const cashBankedMTD = sumNet(perf?.days);
  const netSignedMTD = sumNet(sales?.days);
  const ytdNet = fin?.ytd?.net || 0;
  const outstanding = pending ? (Number(pending.totals?.invoiced || 0) + Number(pending.totals?.notInvoiced || 0)) : 0;
  const monthTarget = Number(cashflowTargets?.minimum || 0);

  const perfSpark = useMemo(() => {
    if (!perf?.days?.length) return [];
    let run = 0;
    return perf.days.map((d) => { run += Number(d.net) || 0; return { v: run }; });
  }, [perf]);

  const trendChart = useMemo(
    () => (trend?.months || []).slice(-12).map((m) => ({ label: shortMonth(m.month), cashIn: m.cashIn, pps: m.pps })),
    [trend],
  );

  // ── Partners (everyone). ──
  const activePartners = useMemo(
    () => (state.partnerCreditsList || []).filter((p) => p.status === 'active' || p.status === 'credits_only'),
    [state.partnerCreditsList],
  );
  const partnerTotal = activePartners.reduce((s, p) => s + (Number(p.outstanding) || 0), 0);
  const recurringMonthly = partnerTotal + (canBusiness ? Number(pending?.totals?.other || 0) : 0);

  // ── Pipeline (everyone — derived from in-state deals). ──
  const dealList = useMemo(() => Object.values(state.deals || {}), [state.deals]);
  const pipeline = useMemo(() => {
    const open = PIPELINE_STAGES.filter((s) => s.id !== 'paid' && s.id !== 'lost');
    const counts = Object.fromEntries(PIPELINE_STAGES.map((s) => [s.id, 0]));
    let openCount = 0; let openValue = 0;
    for (const d of dealList) {
      const stage = counts[d.stage] != null ? d.stage : 'lead';
      counts[stage] += 1;
      if (stage !== 'paid' && stage !== 'lost') {
        openCount += 1;
        openValue += Number(d.effectiveValue ?? d.value) || 0;
      }
    }
    return {
      items: open.map((s) => ({ id: s.id, label: s.label, color: s.color, count: counts[s.id] })),
      openCount, openValue,
    };
  }, [dealList]);

  // ── Production (production.access — derived from in-state videos). ──
  const production = useMemo(() => {
    const vids = state.productionVideos || [];
    const counts = Object.fromEntries(PRODUCTION_PHASES.map((p) => [p.id, 0]));
    for (const v of vids) if (counts[v.productionPhase] != null) counts[v.productionPhase] += 1;
    const items = PRODUCTION_PHASES.map((p) => ({ id: p.id, label: p.label, color: p.color, count: counts[p.id] }));
    const liveCount = (counts.pre_production || 0) + (counts.production || 0);
    return { items, liveCount, total: vids.length };
  }, [state.productionVideos]);

  // ── Tasks & quote requests (everyone — formulas mirror CrmTopBar). ──
  const tasksDue = (state.tasks || []).filter((t) => !t.doneAt && t.dueAt && new Date(t.dueAt).getTime() <= Date.now()).length;
  const newQuotes = (state.quoteRequests || []).filter((q) => q.status === 'new').length;

  // ── Recent activity — recently moved/signed deals + completed tasks. ──
  const recent = useMemo(() => {
    const fromDeals = dealList
      .filter((d) => d.stageChangedAt && (d.stage === 'signed' || d.stage === 'paid'))
      .map((d) => ({ kind: 'deal', at: d.stageChangedAt, id: d.id, title: d.company || d.title || 'Untitled deal', meta: d.stage === 'paid' ? 'Paid' : 'Signed', color: d.stage === 'paid' ? GREEN : BRAND.blue }));
    const fromTasks = (state.tasks || [])
      .filter((t) => t.doneAt)
      .map((t) => ({ kind: 'task', at: t.doneAt, id: t.dealId || null, title: t.title || 'Task', meta: 'Task done', color: PURPLE }));
    return [...fromDeals, ...fromTasks].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 7);
  }, [dealList, state.tasks]);

  const heroTarget = monthTarget > 0 ? monthTarget : 0;
  const heroPct = heroTarget > 0 ? Math.round((cashBankedMTD / heroTarget) * 100) : 0;
  const heroBanked = useCountUp(canBusiness ? cashBankedMTD : 0);
  const wdLeft = workingDaysLeftInMonth();

  const sectionGap = 18;

  return (
    <div style={{ padding: isMobile ? '20px 14px 56px' : '32px 24px 64px', maxWidth: 1440, margin: '0 auto' }}>
      {/* ── Hero band ── */}
      <div
        style={{
          position: 'relative', overflow: 'hidden', borderRadius: 18, padding: isMobile ? '22px 20px' : '30px 32px',
          background: `linear-gradient(135deg, ${BRAND.ink} 0%, #15506b 45%, ${BRAND.blue} 130%)`,
          color: 'white', marginBottom: sectionGap, boxShadow: '0 12px 30px rgba(15,42,61,0.22)',
          ...riseStyle(0),
        }}
      >
        {/* Decorative glow */}
        <div style={{ position: 'absolute', top: -80, right: -40, width: 280, height: 280, borderRadius: '50%', background: 'radial-gradient(circle, rgba(43,184,230,0.45), transparent 70%)', pointerEvents: 'none' }} />
        <div style={{ position: 'relative', display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 18 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: 0.8, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>
              <Sparkles size={14} /> Mission Control
            </div>
            <h1 style={{ margin: '8px 0 4px', fontSize: isMobile ? 24 : 30, fontWeight: 800, letterSpacing: -0.5 }}>
              {greeting}{firstName ? `, ${firstName}` : ''}
            </h1>
            <div style={{ fontSize: 14, opacity: 0.85 }}>
              {now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </div>
          </div>

          {canBusiness ? (
            <div style={{ display: 'flex', gap: isMobile ? 18 : 36, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.8 }}>Cash banked · {monthName}</div>
                <div style={{ fontSize: isMobile ? 30 : 38, fontWeight: 800, letterSpacing: -1, lineHeight: 1.1 }}>{gbp0(heroBanked)}</div>
                <div style={{ fontSize: 12.5, opacity: 0.85 }}>
                  {heroTarget > 0 ? `${heroPct}% of ${gbp0(heroTarget)} target · ${wdLeft} working days left` : `${wdLeft} working days left this month`}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.8 }}>Signed · {monthName}</div>
                <div style={{ fontSize: isMobile ? 30 : 38, fontWeight: 800, letterSpacing: -1, lineHeight: 1.1 }}>{gbp0(netSignedMTD)}</div>
                <div style={{ fontSize: 12.5, opacity: 0.85 }}>New business won (ex-VAT)</div>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: isMobile ? 18 : 36, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.8 }}>Open deals</div>
                <div style={{ fontSize: isMobile ? 30 : 38, fontWeight: 800, letterSpacing: -1, lineHeight: 1.1 }}>{pipeline.openCount}</div>
              </div>
              {canProduction && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.8 }}>Live projects</div>
                  <div style={{ fontSize: isMobile ? 30 : 38, fontWeight: 800, letterSpacing: -1, lineHeight: 1.1 }}>{production.liveCount}</div>
                </div>
              )}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.8 }}>Tasks due</div>
                <div style={{ fontSize: isMobile ? 30 : 38, fontWeight: 800, letterSpacing: -1, lineHeight: 1.1 }}>{tasksDue}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── KPI row (finance-gated) ── */}
      {canBusiness && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginBottom: sectionGap }}>
          <KpiCard icon={Wallet} accent={GREEN} label={`Cash banked · ${monthName}`} value={cashBankedMTD} sub="Net received this month" onClick={onOpenFinance} spark={perfSpark} delay={1} />
          <KpiCard icon={TrendingUp} accent={BRAND.blue} label={`Signed · ${monthName}`} value={netSignedMTD} sub="New business (ex-VAT)" onClick={onOpenFinance} delay={2} />
          <KpiCard icon={PoundSterling} accent={AMBER} label="Outstanding to collect" value={outstanding} sub="Across all pending payments" onClick={onOpenFinance} delay={3} />
          <KpiCard icon={Coins} accent={PURPLE} label="Recurring income" value={recurringMonthly} sub={`${activePartners.length} active partner${activePartners.length === 1 ? '' : 's'} + other`} onClick={onOpenPartners} delay={4} />
          <KpiCard icon={Landmark} accent={TEAL} label="Net revenue · YTD" value={ytdNet} sub={`${year} cash banked, ex-VAT`} onClick={onOpenFinance} delay={5} />
        </div>
      )}

      {/* ── Pacing ring + 12-month trend (finance-gated) ── */}
      {canBusiness && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '320px 1fr', gap: sectionGap, marginBottom: sectionGap }}>
          <Panel title={`${monthName} pacing`} icon={Gauge} onOpen={onOpenFinance} delay={6}>
            {monthTarget > 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                <ProgressRing value={cashBankedMTD} max={monthTarget} color={heroPct >= 100 ? GREEN : BRAND.blue} />
                <div style={{ fontSize: 13, color: BRAND.ink, lineHeight: 1.7 }}>
                  <div><strong style={{ fontSize: 16 }}>{gbp0(cashBankedMTD)}</strong> banked</div>
                  <div style={{ color: BRAND.muted }}>of {gbp0(monthTarget)} target</div>
                  <div style={{ marginTop: 6, color: cashBankedMTD >= monthTarget ? GREEN : AMBER, fontWeight: 700 }}>
                    {cashBankedMTD >= monthTarget ? 'Target hit 🎉' : `${gbp0(monthTarget - cashBankedMTD)} to go`}
                  </div>
                  <div style={{ color: BRAND.muted, fontSize: 12, marginTop: 2 }}>{wdLeft} working days left</div>
                </div>
              </div>
            ) : (
              <div style={{ color: BRAND.muted, fontSize: 13, padding: '20px 0' }}>
                Set a monthly target in <button className="btn-link" onClick={onOpenFinance}>Cash Flow & Targets</button> to track pacing here.
              </div>
            )}
          </Panel>

          <Panel title="Cash in — last 12 months" icon={TrendingUp} onOpen={onOpenFinance} delay={7}>
            {!trend ? (
              <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center', color: BRAND.muted, fontSize: 14 }}>Loading…</div>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={trendChart} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={BRAND.border} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 12, fill: BRAND.muted }} />
                  <YAxis tickFormatter={gbpK} tick={{ fontSize: 12, fill: BRAND.muted }} width={52} />
                  <Tooltip formatter={(v, n) => [formatGBP(v), n === 'cashIn' ? 'Cash in' : 'Money owed']} cursor={{ fill: 'rgba(43,184,230,0.06)' }} />
                  <Bar dataKey="cashIn" name="Cash in" fill={BRAND.blue} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>
        </div>
      )}

      {/* ── Pipeline + Production ── */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: sectionGap, marginBottom: sectionGap }}>
        <Panel title="Sales pipeline" icon={KanbanSquare} onOpen={onOpenPipeline} delay={8}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: BRAND.ink }}>{pipeline.openCount}</div>
            <div style={{ fontSize: 13, color: BRAND.muted }}>open deals · {gbp0(pipeline.openValue)} in play</div>
          </div>
          <StageBar items={pipeline.items} onOpen={onOpenPipeline} />
        </Panel>

        {canProduction ? (
          <Panel title="Production" icon={Clapperboard} onOpen={onOpenProduction} delay={9}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
              <div style={{ fontSize: 26, fontWeight: 800, color: BRAND.ink }}>{production.liveCount}</div>
              <div style={{ fontSize: 13, color: BRAND.muted }}>live projects · {production.total} total</div>
            </div>
            <StageBar items={production.items} onOpen={onOpenProduction} />
          </Panel>
        ) : (
          <Panel title="Partners & credits" icon={Coins} onOpen={onOpenPartners} delay={9}>
            <PartnersBody activePartners={activePartners} partnerTotal={partnerTotal} onOpenPartner={onOpenPartner} />
          </Panel>
        )}
      </div>

      {/* ── Pending payments (finance-gated) ── */}
      {canBusiness && pending && (
        <Panel title="Pending payments" icon={PiggyBank} onOpen={onOpenFinance} delay={10}>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 12, marginBottom: 14 }}>
            <MiniStat label="Invoiced — awaiting" value={pending.totals?.invoiced} accent={AMBER} />
            <MiniStat label="Not yet invoiced" value={pending.totals?.notInvoiced} accent={BRAND.ink} />
            <MiniStat label="Imported PP / PO" value={pending.totals?.manual} accent={BRAND.muted} />
            <MiniStat label="Recurring (partners + other)" value={recurringMonthly} accent={PURPLE} />
          </div>
          <TopOutstanding pending={pending} onOpenDeal={onOpenDeal} />
        </Panel>
      )}

      {/* ── Tasks / Quote requests / Partners / Recent activity ── */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: sectionGap, marginTop: sectionGap }}>
        <Panel title="Today's workload" icon={CheckSquare} delay={11}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <ActionTile icon={CheckSquare} label="Tasks due" value={tasksDue} accent={tasksDue > 0 ? AMBER : GREEN} onClick={onOpenTasks} />
            <ActionTile icon={MailQuestion} label="New quote requests" value={newQuotes} accent={newQuotes > 0 ? BRAND.blue : BRAND.muted} onClick={onOpenQuoteRequests} />
          </div>
          {(canProduction) && (
            <div style={{ marginTop: 12 }}>
              <ActionTile icon={Layers} label="Live projects in production" value={production.liveCount} accent={PURPLE} onClick={onOpenProjects} wide />
            </div>
          )}
        </Panel>

        <Panel title="Recent activity" icon={TrendingUp} delay={12}>
          {recent.length === 0 ? (
            <div style={{ color: BRAND.muted, fontSize: 13, padding: '12px 0' }}>No recent activity yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {recent.map((r, i) => (
                <button
                  key={`${r.kind}-${r.id}-${i}`}
                  onClick={() => r.id && onOpenDeal(r.id)}
                  disabled={!r.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 6px', border: 'none', background: 'transparent',
                    borderBottom: i < recent.length - 1 ? '1px solid ' + BRAND.border : 'none', textAlign: 'left',
                    cursor: r.id ? 'pointer' : 'default', borderRadius: 6,
                  }}
                  onMouseEnter={(e) => { if (r.id) e.currentTarget.style.background = BRAND.paper; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: r.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 13.5, color: BRAND.ink, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: r.color, textTransform: 'uppercase', letterSpacing: 0.4 }}>{r.meta}</span>
                  <span style={{ fontSize: 12, color: BRAND.muted, minWidth: 56, textAlign: 'right' }}>{daysAgoLabel(r.at)}</span>
                </button>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function MiniStat({ label, value, accent }) {
  return (
    <div style={{ background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 800, color: accent || BRAND.ink }}>{gbp0(value)}</div>
    </div>
  );
}

function ActionTile({ icon: Icon, label, value, accent, onClick, wide }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '14px 16px', borderRadius: 12,
        border: '1px solid ' + BRAND.border, background: 'white', cursor: 'pointer', textAlign: 'left',
        boxShadow: '0 1px 2px rgba(15,42,61,0.04)', transition: 'transform 140ms ease, box-shadow 140ms ease',
      }}
      onMouseEnter={(e) => liftHandlers(e, true)}
      onMouseLeave={(e) => liftHandlers(e, false)}
    >
      <span style={{ width: 38, height: 38, borderRadius: 10, background: (accent || BRAND.blue) + '18', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon size={18} color={accent || BRAND.blue} />
      </span>
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', fontSize: 24, fontWeight: 800, color: BRAND.ink, lineHeight: 1.1 }}>{value}</span>
        <span style={{ display: 'block', fontSize: 12.5, color: BRAND.muted, marginTop: 2 }}>{label}</span>
      </span>
      <ArrowUpRight size={16} color={BRAND.muted} style={{ opacity: 0.5 }} />
    </button>
  );
}

function PartnersBody({ activePartners, partnerTotal, onOpenPartner }) {
  const top = [...activePartners].sort((a, b) => (Number(b.outstanding) || 0) - (Number(a.outstanding) || 0)).slice(0, 5);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
        <div style={{ fontSize: 26, fontWeight: 800, color: BRAND.ink }}>{activePartners.length}</div>
        <div style={{ fontSize: 13, color: BRAND.muted }}>active partners · {gbp0(partnerTotal)} outstanding</div>
      </div>
      {top.length === 0 ? (
        <div style={{ color: BRAND.muted, fontSize: 13 }}>No active partner subscriptions.</div>
      ) : top.map((p) => (
        <button
          key={p.clientKey}
          onClick={() => onOpenPartner && onOpenPartner(p.clientKey)}
          style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 6px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', borderRadius: 6 }}
          onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.paper; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <Coins size={14} color={PURPLE} />
          <span style={{ flex: 1, fontSize: 13.5, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.clientName || 'Partner'}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink }}>{gbp0(p.outstanding)}</span>
        </button>
      ))}
    </div>
  );
}

function TopOutstanding({ pending, onOpenDeal }) {
  const rows = useMemo(() => {
    const all = [...(pending.normal || []), ...(pending.po || [])]
      .filter((d) => d.dealId && (Number(d.outstanding) || 0) > 0)
      .sort((a, b) => (Number(b.outstanding) || 0) - (Number(a.outstanding) || 0))
      .slice(0, 5);
    return all;
  }, [pending]);
  if (rows.length === 0) return <div style={{ color: BRAND.muted, fontSize: 13 }}>Nothing outstanding right now. 🎉</div>;
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Largest outstanding</div>
      {rows.map((d) => (
        <button
          key={d.dealId}
          onClick={() => onOpenDeal(d.dealId)}
          style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 6px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', borderRadius: 6 }}
          onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.paper; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <span style={{ flex: 1, fontSize: 13.5, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.company || d.title || 'Untitled deal'}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: AMBER }}>{gbp0(d.outstanding)}</span>
        </button>
      ))}
    </div>
  );
}
