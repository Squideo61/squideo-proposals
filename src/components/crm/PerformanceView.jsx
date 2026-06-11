import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TrendingUp, Pencil, Check, X, Wallet, PoundSterling, ChevronDown, Plus, Trash2, Receipt, Landmark, PiggyBank, Users, GripVertical, Briefcase, Megaphone, Crown, Coins, Target, Paperclip, Download, Ban, Camera } from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, useIsMobile, workingDaysBetween, ukBankHolidays, todayKey, formatRelativeTime } from '../../utils.js';

const PPS_COLOR = '#F59E0B';
const PREDICT_COLOR = '#7C3AED';
// The two company directors — the Directors tab (and its API) is limited to these
// two email addresses. Mirrors DIRECTOR_EMAILS in api/_lib/crm/stats.js.
const DIRECTOR_EMAILS = new Set(['adam@squideo.co.uk', 'ben@squideo.co.uk']);
// 'YYYY-MM' → "Jun '24" (the trailing window spans up to 3 years).
const monthShortYear = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'short' }) + " '" + String(y).slice(2);
};

// Fallback if settings hasn't loaded targets yet (matches api/settings.js seed).
export const FALLBACK_TARGETS = [
  { key: 'minimum', label: 'Minimum', amount: 27806.92, color: '#F59E0B' },
  { key: 't4k', label: '4k', amount: 30606.92, color: '#94A3B8' },
  { key: 'dream', label: 'Dream 5k', amount: 33406.92, color: '#EAB308' },
];

// Resolve the live monthly income targets — saved labels/colours with amounts
// sourced from the Cash Flow & Targets figures (Minimum / £4k / £5k, in order)
// when present. Shared with the Finance Predicted tab's over/under-target metric.
export function resolveIncomeTargets(financeTargets, cashflowTargets) {
  const saved = (financeTargets && financeTargets.length) ? financeTargets : FALLBACK_TARGETS;
  if (!cashflowTargets) return saved;
  const amounts = [cashflowTargets.minimum, ...(Array.isArray(cashflowTargets.draws) ? cashflowTargets.draws.map((d) => d.amount) : [])];
  return saved.map((t, i) => (i < amounts.length && amounts[i] != null ? { ...t, amount: amounts[i] } : t));
}

const gbpK = (v) => '£' + Math.round((Number(v) || 0) / 1000) + 'k';

// Recent month / quarter period keys, newest first, for the dropdown.
function recentMonths(n = 12) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
function recentQuarters(n = 8) {
  const out = [];
  const now = new Date();
  let y = now.getFullYear();
  let q = Math.floor(now.getMonth() / 3) + 1;
  for (let i = 0; i < n; i++) {
    out.push(`${y}-Q${q}`);
    q -= 1; if (q < 1) { q = 4; y -= 1; }
  }
  return out;
}

// Resolve a period key into a [startKey, endKey) range, span and label.
function periodRange(period) {
  if (/^\d{4}-Q[1-4]$/.test(period)) {
    const [y, q] = period.split('-Q').map(Number);
    const sM = (q - 1) * 3; // 0-based start month
    const startKey = `${y}-${String(sM + 1).padStart(2, '0')}-01`;
    const endY = sM + 3 >= 12 ? y + 1 : y;
    const endKey = `${endY}-${String(((sM + 3) % 12) + 1).padStart(2, '0')}-01`;
    return { startKey, endKey, spanMonths: 3, label: `Q${q} ${y}` };
  }
  const [y, m] = period.split('-').map(Number);
  const endY = m === 12 ? y + 1 : y;
  const endKey = `${endY}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
  return {
    startKey: `${y}-${String(m).padStart(2, '0')}-01`,
    endKey,
    spanMonths: 1,
    label: new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' }),
  };
}

const monthOptionLabel = (k) => {
  const [y, m] = k.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
};

// The Performance block, designed to sit at the top of the Finance page (self
// contained: its own Month/Quarter + Income/Sales toggles, targets editor and
// day-pace chart). No page chrome of its own — the host page provides that.
// `section`/`onSection` let the host (Finance page) lift the Income/Sales toggle
// so it can also drive the breakdown below. Uncontrolled (own state) if omitted.
export function PerformancePanel({ section: sectionProp, onSection, predictedTotal = 0, predictedMonthKey = null } = {}) {
  const { state, actions } = useStore();
  const isMobile = useIsMobile();
  const [mode, setMode] = useState('month'); // 'month' | 'quarter'
  const [month, setMonth] = useState(() => todayKey().slice(0, 7));
  const [quarter, setQuarter] = useState(() => recentQuarters(1)[0]);
  const [sectionState, setSectionState] = useState('income'); // 'income' (cash received) | 'sales' (deals signed)
  const section = sectionProp != null ? sectionProp : sectionState;
  const setSection = onSection || setSectionState;
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);

  const period = mode === 'month' ? month : quarter;
  const isSales = section === 'sales';
  const isComparison = section === 'salesvspp';
  const isCashflow = section === 'cashflow';
  const isDirectors = section === 'directors';
  const canDirectors = DIRECTOR_EMAILS.has((state.session?.email || '').toLowerCase());

  useEffect(() => {
    if (!state.bankHolidays) actions.loadBankHolidays();
  }, [actions, state.bankHolidays]);

  // Reload when the period/section changes OR when finance data changes elsewhere
  // (e.g. a PP marked paid bumps state.financeRefresh) so the pace chart stays live.
  useEffect(() => {
    if (isComparison || isCashflow || isDirectors) { setLoading(false); return; } // pacing stats not needed here
    let active = true;
    setLoading(true);
    const load = isSales ? actions.loadSalesStats(period) : actions.loadPerformanceStats(period);
    load.finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [actions, period, isSales, isComparison, isCashflow, isDirectors, state.financeRefresh]);

  // Sales vs PP's needs the rolling 36-month trend + (for the importer) history.
  // Refetch the trend too when finance data changes. Partner credits feed the
  // outstanding partner total added to the latest "money owed" point.
  useEffect(() => {
    if (isComparison) { actions.loadTrend(36); actions.fetchPartnerCreditsList(); }
  }, [actions, isComparison, state.financeRefresh]);

  // Outstanding partner total (active partners not yet collected this month).
  const partnerOutstanding = (state.partnerCreditsList || [])
    .filter((p) => p.status === 'active' || p.status === 'credits_only')
    .reduce((s, p) => s + (Number(p.outstanding) || 0), 0);

  // Income targets mirror the Cash Flow & Targets figures live: keep each saved
  // target's label/colour but source its amount from the cashflow targets
  // (Minimum / £4k / £5k, in order). Sales targets stay manually managed.
  useEffect(() => {
    if (!isSales && !isComparison) actions.loadCashflowTargets();
  }, [actions, isSales, isComparison, state.financeRefresh]);

  const targetSource = isSales ? state.salesTargets : state.financeTargets;
  const savedTargets = (targetSource && targetSource.length) ? targetSource : FALLBACK_TARGETS;
  const cfTargets = state.cashflowTargets;
  const targets = useMemo(() => {
    if (isSales || !cfTargets) return savedTargets;
    const amounts = [cfTargets.minimum, ...(Array.isArray(cfTargets.draws) ? cfTargets.draws.map((d) => d.amount) : [])];
    return savedTargets.map((t, i) => (i < amounts.length && amounts[i] != null ? { ...t, amount: amounts[i] } : t));
  }, [savedTargets, cfTargets, isSales]);
  const holidays = useMemo(
    () => (Array.isArray(state.bankHolidays) && state.bankHolidays.length ? new Set(state.bankHolidays) : ukBankHolidays),
    [state.bankHolidays],
  );
  const activeStats = isSales ? state.salesStats : state.performanceStats;
  const perf = activeStats && activeStats.period === period ? activeStats : null;

  const model = useMemo(() => {
    const { startKey, endKey, spanMonths, label } = periodRange(period);
    const workingDays = workingDaysBetween(startKey, endKey, holidays);
    const N = workingDays.length || 1;
    const serverDays = (perf?.days || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const cumTo = (dateStr) => {
      let s = 0;
      for (const d of serverDays) { if (d.date <= dateStr) s += Number(d.net) || 0; else break; }
      return s;
    };

    const tKey = todayKey();
    const lastActualIdx = workingDays.filter((wd) => wd <= tKey).length;
    const status = lastActualIdx === 0 ? 'future' : (lastActualIdx >= N ? 'complete' : 'in_progress');

    const netSoFar = lastActualIdx > 0 ? cumTo(workingDays[lastActualIdx - 1]) : 0;
    const projected = lastActualIdx > 0 ? (netSoFar / lastActualIdx) * N : 0;

    // "With predicted" projection — a faint line from today's cash position rising
    // to the month-end if every flagged predicted payment lands. Income, current
    // month only, while the period is still running and something's predicted.
    const predTotal = Number(predictedTotal) || 0;
    const showPredicted = !isSales && period === predictedMonthKey && predTotal > 0 && lastActualIdx > 0 && lastActualIdx < N;
    const predictedMonthEnd = netSoFar + predTotal;

    const data = workingDays.map((wd, i) => {
      const dayNum = i + 1;
      const point = { day: dayNum };
      point.actual = dayNum <= lastActualIdx ? Number(cumTo(wd).toFixed(2)) : null;
      for (const t of targets) point[t.key] = Number(((Number(t.amount) || 0) * spanMonths * dayNum / N).toFixed(2));
      // A flat reference line across the whole graph at the theoretical maximum
      // income (banked so far + everything predicted) — not a diagonal projection.
      point.predicted = showPredicted ? Number(predictedMonthEnd.toFixed(2)) : null;
      return point;
    });

    return { N, lastActualIdx, data, netSoFar, projected, status, spanMonths, label, showPredicted, predictedMonthEnd, predTotal };
  }, [perf, period, targets, holidays, isSales, predictedTotal, predictedMonthKey]);

  return (
    <section style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <TrendingUp size={20} color={BRAND.blue} />
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Performance</h2>
            <p style={{ fontSize: 13, color: BRAND.muted, margin: '2px 0 0' }}>
              {isDirectors
                ? 'Director expenses — each director’s £250/month allowance with carried-over underspend and an ongoing balancing adjustment. Log spend, attach an invoice, and download the month’s invoices for Hubdoc.'
                : isCashflow
                ? 'Company costs vs cash received — each month’s profit, the Corporation Tax to set aside (HMRC marginal relief), and the monthly revenue targets that fund your wages.'
                : isComparison
                  ? "Cash received each month vs new money owed created that month (ex-VAT), over the last 36 months. The latest owed point previews all outstanding cash still to collect (invoiced or not)."
                  : isSales
                    ? 'New business signed (ex-VAT) across all customers, paced against your sales targets by working day.'
                    : 'Cash received (ex-VAT) across all customers, paced against your income targets by working day.'}
            </p>
          </div>
        </div>
        {!isComparison && !isCashflow && !isDirectors && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* Income targets are derived automatically from Cash Flow & Targets,
                so the editor is only offered for the (manual) sales targets. */}
            {isSales && (
              <button onClick={() => setEditing((v) => !v)} className="btn-ghost" title="Edit sales targets">
                <Pencil size={14} /> Targets
              </button>
            )}
            <Segmented
              value={mode}
              onChange={setMode}
              options={[{ value: 'month', label: 'Month' }, { value: 'quarter', label: 'Quarter' }]}
            />
            <select
              value={period}
              onChange={(e) => (mode === 'month' ? setMonth(e.target.value) : setQuarter(e.target.value))}
              style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid ' + BRAND.border, background: 'white', fontSize: 14, color: BRAND.ink }}
            >
              {mode === 'month'
                ? recentMonths(12).map((k) => <option key={k} value={k}>{monthOptionLabel(k)}</option>)
                : recentQuarters(8).map((k) => { const [y, q] = k.split('-Q'); return <option key={k} value={k}>{`Q${q} ${y}`}</option>; })}
            </select>
          </div>
        )}
      </div>

      {/* The three Performance views. */}
      <div style={{ marginBottom: 16 }}>
        <Segmented
          big
          value={section}
          onChange={setSection}
          options={[
            { value: 'income', label: 'Income performance' },
            { value: 'sales', label: 'Sales performance' },
            { value: 'salesvspp', label: "Sales vs PP's" },
            { value: 'cashflow', label: 'Cash Flow & Targets' },
            ...(canDirectors ? [{ value: 'directors', label: 'Directors' }] : []),
          ]}
        />
      </div>

      {isComparison && (
        <SalesVsPpView trend={state.trend} isMobile={isMobile} actions={actions} history={state.salesHistory} partnerOutstanding={partnerOutstanding} />
      )}

      {isCashflow && (
        <CashFlowView isMobile={isMobile} />
      )}

      {isDirectors && canDirectors && (
        <DirectorsView isMobile={isMobile} />
      )}

      {isSales && editing && (
        <TargetEditor
          key={section}
          heading="Monthly sales targets"
          targets={targets}
          onSave={(list) => { actions.saveSalesTargets(list); setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      )}

      {/* Pace strip: current position, plus (Sales only) each target's expected
          pace. The per-target pace cards were dropped from Income performance —
          "Remaining to make targets" below covers target progress there. */}
      {!isComparison && !isCashflow && !isDirectors && (<>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : `repeat(${isSales ? targets.length + 1 : 1}, 1fr)`, gap: 12, marginBottom: 16 }}>
        <PaceCard
          title={model.status === 'future' ? 'Upcoming period' : `Working day ${model.lastActualIdx} of ${model.N}`}
          big={formatGBP(model.netSoFar)}
          sub={(() => {
            if (model.status === 'complete') return `${isSales ? 'Signed' : 'Net banked'} (final)`;
            if (model.status === 'future') return `No ${isSales ? 'sales' : 'cash'} yet`;
            // Sales keeps the run-rate projection; Income shows the projected
            // month-end with predicted payments (banked + predicted) instead.
            if (isSales) return `Signed so far · projected ${formatGBP(model.projected)} by end`;
            return model.showPredicted
              ? `Net banked so far · projected month-end ${formatGBP(model.predictedMonthEnd)} with predicted`
              : 'Net banked so far';
          })()}
          color={BRAND.blue}
        />
        {isSales && targets.map((t) => {
          const target = (Number(t.amount) || 0) * model.spanMonths;
          const expected = target * (model.lastActualIdx / model.N);
          const delta = model.netSoFar - expected;
          const ahead = delta >= 0;
          return (
            <PaceCard
              key={t.key}
              title={`${t.label} · ${formatGBP(target)}`}
              big={(ahead ? '+' : '−') + formatGBP(Math.abs(delta))}
              sub={`${ahead ? 'ahead of' : 'behind'} pace · expected ${formatGBP(expected)}`}
              color={ahead ? '#10B981' : '#EF4444'}
              accent={t.color}
            />
          );
        })}
      </div>

      {/* What's left to hit each target, and the daily run-rate needed for the
          working days remaining. */}
      <RemainingCard targets={targets} model={model} isSales={isSales} isMobile={isMobile} />

      {/* The Day Performance chart. */}
      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 12 : 20 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          {isSales ? 'Sales performance' : (mode === 'quarter' ? 'Quarter performance' : 'Day Performance')} — {model.label}
        </h3>
        {loading ? (
          <div style={{ height: 360, display: 'flex', alignItems: 'center', justifyContent: 'center', color: BRAND.muted, fontSize: 14 }}>Loading…</div>
        ) : (
          <ResponsiveContainer width="100%" height={360}>
            <LineChart data={model.data} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={BRAND.border} />
              <XAxis dataKey="day" tick={{ fontSize: 12, fill: BRAND.muted }} label={{ value: 'Working day', position: 'insideBottom', offset: -2, fontSize: 11, fill: BRAND.muted }} />
              <YAxis tickFormatter={gbpK} tick={{ fontSize: 12, fill: BRAND.muted }} width={56} />
              <Tooltip
                formatter={(v, n) => [formatGBP(v), n]}
                labelFormatter={(d) => `Working day ${d}`}
                cursor={{ stroke: BRAND.border }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {targets.map((t) => (
                <Line key={t.key} type="monotone" dataKey={t.key} name={t.label} stroke={t.color} strokeWidth={1.5} dot={false} />
              ))}
              <Line type="monotone" dataKey="actual" name={isSales ? 'Sales signed (net)' : 'Cash received (net)'} stroke={BRAND.blue} strokeWidth={2.75} dot={false} connectNulls={false} />
              {model.showPredicted && (
                <Line type="monotone" dataKey="predicted" name="Theoretical max (with predicted)" stroke={PREDICT_COLOR} strokeWidth={1.5} strokeDasharray="5 4" strokeOpacity={0.32} dot={false} connectNulls isAnimationActive={false} />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      </>)}
    </section>
  );
}

// Sales vs PP's — cash received each month vs new money owed created that month
// over the last 36 months. The owed line is tomorrow's income, so the gap reads
// as the forward pipeline. Admins can backfill pre-CRM months from the sheet.
function SalesVsPpView({ trend, isMobile, actions, history, partnerOutstanding = 0 }) {
  const months = trend?.months || [];
  const chart = useMemo(() => months.map((m, i) => ({
    label: monthShortYear(m.month),
    cashIn: m.cashIn,
    // The latest point previews ALL outstanding cash still owed (invoiced or
    // not), not just what was created that month — plus the outstanding partner
    // fees (recurring income owed) that sit outside signings/extras.
    pps: (i === months.length - 1)
      ? (m.ppsOutstanding != null ? m.ppsOutstanding : m.pps) + (Number(partnerOutstanding) || 0)
      : m.pps,
  })), [months, partnerOutstanding]);
  const totals = months.reduce(
    (a, m) => ({ cashIn: a.cashIn + (m.cashIn || 0), pps: a.pps + (m.pps || 0) }),
    { cashIn: 0, pps: 0 },
  );
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, 1fr)', gap: 12, marginBottom: 16 }}>
        <StatCard icon={Wallet} accent={BRAND.blue} label="Cash in — last 36 months" value={formatGBP(totals.cashIn)} sub="Payments received (ex-VAT)" />
        <StatCard icon={PoundSterling} accent={PPS_COLOR} label="New money owed — last 36 months" value={formatGBP(totals.pps)} sub="Created by signings + extras — future income" />
      </div>

      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 12 : 20, marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          Sales vs PP's — last 36 months
        </h3>
        {!trend ? (
          <div style={{ height: 360, display: 'flex', alignItems: 'center', justifyContent: 'center', color: BRAND.muted, fontSize: 14 }}>Loading…</div>
        ) : (
          <ResponsiveContainer width="100%" height={360}>
            <LineChart data={chart} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={BRAND.border} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: BRAND.muted }} interval="preserveStartEnd" minTickGap={24} />
              <YAxis tickFormatter={gbpK} tick={{ fontSize: 12, fill: BRAND.muted }} width={56} />
              <Tooltip formatter={(v, n) => [formatGBP(v), n]} cursor={{ stroke: BRAND.border }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="cashIn" name="Sales (cash in)" stroke={BRAND.blue} strokeWidth={2.5} dot={false} />
              <Line type="monotone" dataKey="pps" name="PP's (money owed)" stroke={PPS_COLOR} strokeWidth={2.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <ImportHistoryPanel actions={actions} history={history} isMobile={isMobile} />
    </>
  );
}

// Cash Flow & Targets — company costs vs cash received: each month's profit, the
// Corporation Tax to set aside (HMRC marginal relief on the trailing-12m profit)
// and the wage-based revenue targets. Its own month picker (independent of the page),
// a costs editor (recurring overheads + one-offs), a 12-month history and an
// activity feed. Admin + Director only — rides on the Finance page's finance.manage gate.
const PROFIT_POS = '#10B981';
const PROFIT_NEG = '#EF4444';

function CashFlowView({ isMobile }) {
  const { state, actions } = useStore();
  const [month, setMonth] = useState(() => todayKey().slice(0, 7));

  // Reload the viewed month and refresh the shared current-month targets slice so
  // the Income performance graph reflects cost edits straight away (it reads
  // state.cashflowTargets reactively).
  const reload = () => { actions.loadCashflowTargets(); return actions.loadCashflow(month); };
  useEffect(() => { actions.loadCashflow(month); }, [actions, month, state.financeRefresh]);

  const cf = state.cashflow && state.cashflow.month === month ? state.cashflow : null;
  const monthLabel = monthOptionLabel(month);

  if (!cf) {
    return (
      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 40, textAlign: 'center', color: BRAND.muted, fontSize: 14 }}>
        Loading cash flow…
      </div>
    );
  }

  const sel = cf.selected;
  const ct = cf.corpTax;
  const profitColor = sel.profit >= 0 ? PROFIT_POS : PROFIT_NEG;

  return (
    <>
      {/* Month picker — lets you step back through previous months. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: BRAND.muted }}>Cash flow for <strong style={{ color: BRAND.ink }}>{monthLabel}</strong></span>
        <select
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid ' + BRAND.border, background: 'white', fontSize: 14, color: BRAND.ink }}
        >
          {recentMonths(24).map((k) => <option key={k} value={k}>{monthOptionLabel(k)}</option>)}
        </select>
      </div>

      {/* Headline figures for the selected month. */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        <StatCard icon={TrendingUp} accent={profitColor} label={`Profit — ${monthLabel}`}
          value={<span style={{ color: profitColor }}>{formatGBP(sel.profit)}</span>}
          sub="Cash received − costs" />
        <StatCard icon={Wallet} accent={BRAND.blue} label="Cash received"
          value={formatGBP(sel.cashIn)} sub="Net banked (ex-VAT)" />
        <StatCard icon={Receipt} accent="#0E7490" label="Costs"
          value={formatGBP(sel.costs)} sub="All monthly costs (ex-VAT)" />
        <StatCard icon={PiggyBank} accent={VAT_COLOR_CF}
          label={ct.inProfit ? 'Corp Tax to set aside' : 'Corp Tax saving'}
          value={formatGBP(Math.abs(ct.monthReserve))}
          sub={ct.inProfit
            ? `≈${Math.round((ct.effectiveRate || 0) * 100)}% effective · this month`
            : 'This month’s loss reduces your CT'} />
      </div>

      {/* Monthly revenue targets — minimum (cost base) + the wage-uplift targets. */}
      {cf.targets && <CfTargets targets={cf.targets} isMobile={isMobile} />}

      {/* Costs editor — recurring overheads + one-offs for the month. */}
      <CfCosts lines={cf.lines} month={month} monthLabel={monthLabel} actions={actions} reload={reload} isMobile={isMobile} />

      {/* 12-month history — click a month to jump to it. */}
      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 12 : 20, marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>Last 12 months</h3>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'right', color: BRAND.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                <th style={{ textAlign: 'left', padding: '8px 8px' }}>Month</th>
                <th style={{ padding: '8px 8px' }}>Cash in</th>
                <th style={{ padding: '8px 8px' }}>Costs</th>
                <th style={{ padding: '8px 8px' }}>Profit</th>
              </tr>
            </thead>
            <tbody>
              {cf.history.slice().reverse().map((h) => {
                const isThis = h.month === month;
                return (
                  <tr key={h.month}
                    onClick={() => setMonth(h.month)}
                    style={{ borderTop: '1px solid ' + BRAND.border, background: isThis ? '#F4FBFE' : 'transparent', cursor: 'pointer' }}>
                    <td style={{ textAlign: 'left', padding: '8px 8px', fontWeight: isThis ? 700 : 500 }}>{monthShortYear(h.month)}</td>
                    <td style={{ textAlign: 'right', padding: '8px 8px' }}>{formatGBP(h.cashIn)}</td>
                    <td style={{ textAlign: 'right', padding: '8px 8px', color: BRAND.muted }}>{formatGBP(h.costs)}</td>
                    <td style={{ textAlign: 'right', padding: '8px 8px', fontWeight: 700, color: h.profit >= 0 ? PROFIT_POS : PROFIT_NEG }}>{formatGBP(h.profit)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Activity feed — a log of cost changes. */}
      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 12 : 20 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>Cash flow activity</h3>
        {(!cf.activity || cf.activity.length === 0) ? (
          <div style={{ color: BRAND.muted, fontSize: 13, padding: '8px 0' }}>No changes yet — add a cost to get started.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {cf.activity.map((a, i) => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '8px 0', borderTop: i === 0 ? 'none' : '1px solid ' + BRAND.border }}>
                <span style={{ fontSize: 13, color: BRAND.ink, flex: 1, minWidth: 0 }}>{a.summary}</span>
                <span style={{ fontSize: 11, color: BRAND.muted, whiteSpace: 'nowrap' }}>
                  {a.actor ? a.actor.split('@')[0] + ' · ' : ''}{formatRelativeTime(a.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ── Directors expenses ──────────────────────────────────────────────────────
// Directors-only tab: each director's £250/month allowance with carried-over
// underspend (only underspend rolls) and an ongoing balancing adjustment, the
// live difference between the two, per-expense invoice uploads and a one-click
// ZIP of the month's invoices for Hubdoc. Mirrors the CashFlowView layout idioms.
const DIRECTOR_ACCENT = '#CA8A04';

function DirectorsView({ isMobile }) {
  const { state, actions, showMsg } = useStore();
  const [month, setMonth] = useState(() => todayKey().slice(0, 7));

  useEffect(() => { actions.loadDirectorExpenses(month); }, [actions, month, state.financeRefresh]);

  const data = state.directorExpenses && state.directorExpenses.month === month ? state.directorExpenses : null;
  const monthLabel = monthOptionLabel(month);
  const reload = () => actions.loadDirectorExpenses(month);

  const downloadZip = async () => {
    try {
      const res = await fetch('/api/crm/stats/director-zip/' + month, { credentials: 'include' });
      if (!res.ok) { const j = await res.json().catch(() => ({})); showMsg?.(j.error || 'No invoices to download', 'error'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `director-expenses-${month}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch { showMsg?.('Download failed', 'error'); }
  };

  if (!data) {
    return (
      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 40, textAlign: 'center', color: BRAND.muted, fontSize: 14 }}>
        Loading director expenses…
      </div>
    );
  }

  const anyInvoices = data.directors.some((d) => d.expenses.some((e) => e.hasInvoice));
  const [a, b] = data.directors;
  // Who has spent more this month, and by how much.
  const spender = (a?.spent || 0) >= (b?.spent || 0) ? a : b;
  const spendDiff = Math.abs((a?.spent || 0) - (b?.spent || 0));

  return (
    <>
      {/* Month picker + bulk invoice download. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: BRAND.muted }}>Director expenses for <strong style={{ color: BRAND.ink }}>{monthLabel}</strong></span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={downloadZip} disabled={!anyInvoices} className="btn-ghost" title={anyInvoices ? 'Download every invoice for this month as a ZIP' : 'No invoices attached this month'} style={{ opacity: anyInvoices ? 1 : 0.5, cursor: anyInvoices ? 'pointer' : 'not-allowed' }}>
            <Download size={14} /> Download all invoices
          </button>
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid ' + BRAND.border, background: 'white', fontSize: 14, color: BRAND.ink }}
          >
            {recentMonths(24).map((k) => <option key={k} value={k}>{monthOptionLabel(k)}</option>)}
          </select>
        </div>
      </div>

      {/* Difference between the two directors — mirrors the sheet's Difference row. */}
      {a && b && (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderLeft: `3px solid ${DIRECTOR_ACCENT}`, borderRadius: 10, padding: isMobile ? 14 : '12px 18px', marginBottom: 16, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Difference</span>
          <span style={{ fontSize: 13, color: BRAND.muted }}>
            {spendDiff < 0.005
              ? 'Both directors have spent the same this month.'
              : <><strong style={{ color: BRAND.ink }}>{spender.name}</strong> has spent <strong style={{ color: BRAND.ink }}>{formatGBP(spendDiff)}</strong> more</>}
          </span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, 1fr)', gap: 12 }}>
        {data.directors.map((d) => (
          <DirectorColumn key={d.email} d={d} month={month} actions={actions} reload={reload} showMsg={showMsg} />
        ))}
      </div>
    </>
  );
}

// 'YYYY-MM' → the previous month's key (for ending a recurring expense).
function prevMonthKey(mk) {
  let [y, m] = mk.split('-').map(Number);
  m -= 1; if (m < 1) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

function DirectorColumn({ d, month, actions, reload, showMsg }) {
  const [adding, setAdding] = useState(false);
  const [editingBal, setEditingBal] = useState(false);
  const [bal, setBal] = useState(String(d.balanceAdjust || 0));
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const overspent = d.remaining < 0;

  const saveBal = () => {
    actions.setDirectorBalance(d.email, parseFloat(bal) || 0).then(() => { setEditingBal(false); reload(); });
  };
  const cancelBal = () => { setEditingBal(false); setBal(String(d.balanceAdjust || 0)); };

  const onDrop = () => {
    if (dragId && overId && dragId !== overId) {
      const ids = d.expenses.map((e) => e.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(overId);
      if (from >= 0 && to >= 0) {
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        actions.reorderDirectorExpenses(ids).then(reload);
      }
    }
    setDragId(null); setOverId(null);
  };

  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderLeft: `3px solid ${DIRECTOR_ACCENT}`, borderRadius: 12, padding: '14px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Crown size={16} color={DIRECTOR_ACCENT} />
        <span style={{ fontSize: 15, fontWeight: 700, color: BRAND.ink }}>{d.name}</span>
      </div>

      {/* Remaining headroom — the headline figure, coloured by under/over. */}
      <div style={{ fontSize: 26, fontWeight: 800, color: overspent ? PROFIT_NEG : PROFIT_POS, lineHeight: 1.1 }}>
        {overspent ? `Over by ${formatGBP(-d.remaining)}` : `${formatGBP(d.remaining)} left`}
      </div>
      <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>
        {formatGBP(d.spent)} spent of {formatGBP(d.available)} available
      </div>

      {/* Allowance breakdown: base + carried underspend ± standing balance. */}
      <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 8, lineHeight: 1.5 }}>
        {formatGBP(d.allowance)} monthly
        {d.carriedIn > 0.005 && <> + {formatGBP(d.carriedIn)} carried over</>}
        {' '}
        {editingBal ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            · balance £
            <input
              type="number" step="0.01" value={bal} autoFocus
              onChange={(e) => setBal(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveBal(); if (e.key === 'Escape') cancelBal(); }}
              style={{ width: 80, padding: '2px 6px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 12 }}
            />
            <button className="btn-icon" title="Save" onClick={saveBal} style={{ padding: 2 }}><Check size={12} /></button>
            <button className="btn-icon" title="Cancel" onClick={cancelBal} style={{ padding: 2 }}><X size={12} /></button>
          </span>
        ) : (
          <span>
            · balance {d.balanceAdjust >= 0 ? '+' : '−'}{formatGBP(Math.abs(d.balanceAdjust))}
            <button className="btn-icon" title="Adjust the standing balancing amount" onClick={() => setEditingBal(true)} style={{ padding: 2, marginLeft: 2, verticalAlign: 'middle' }}><Pencil size={11} /></button>
          </span>
        )}
        {' = '}<strong style={{ color: BRAND.ink }}>{formatGBP(d.available)}</strong>
      </div>

      {/* Expenses. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Expenses</span>
        <button className="btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => setAdding((v) => !v)}><Plus size={13} /> Add</button>
      </div>

      {adding && <DirExpenseForm directorEmail={d.email} actions={actions} showMsg={showMsg} onDone={() => { setAdding(false); reload(); }} onCancel={() => setAdding(false)} />}

      {d.expenses.length === 0 && !adding ? (
        <div style={{ color: BRAND.muted, fontSize: 13, padding: '4px 0' }}>No expenses logged this month.</div>
      ) : (
        d.expenses.map((e) => (
          <DirExpenseRow
            key={e.id} e={e} month={month} actions={actions} reload={reload} showMsg={showMsg}
            dragging={dragId === e.id} over={overId === e.id && dragId !== e.id}
            onDragStart={() => setDragId(e.id)} onDragOver={() => setOverId(e.id)}
            onDrop={onDrop} onDragEnd={() => { setDragId(null); setOverId(null); }}
          />
        ))
      )}
    </div>
  );
}

function DirExpenseRow({ e, month, actions, reload, showMsg, dragging, over, onDragStart, onDragOver, onDrop, onDragEnd }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);

  const onPick = async (file) => {
    if (!file) return;
    setBusy(true);
    try { await actions.uploadDirectorInvoice(e.id, file); reload(); }
    catch (err) { showMsg?.(err.message || 'Upload failed', 'error'); }
    finally { setBusy(false); }
  };
  const download = async () => {
    try { const r = await actions.getDirectorInvoiceUrl(e.id); if (r?.downloadUrl) window.open(r.downloadUrl, '_blank'); }
    catch { showMsg?.('Could not open invoice', 'error'); }
  };
  const removeFile = () => actions.deleteDirectorInvoice(e.id).then(reload);
  const remove = () => actions.deleteDirectorExpense(e.id).then(reload);
  // Stop a recurring expense from this month onward — keep prior months' history.
  const stopRecurring = () => actions.updateDirectorExpense(e.id, { effectiveTo: prevMonthKey(month) }).then(reload);

  return (
    <div
      draggable
      onDragStart={(ev) => { ev.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragOver={(ev) => { ev.preventDefault(); onDragOver(); }}
      onDrop={(ev) => { ev.preventDefault(); onDrop(); }}
      onDragEnd={onDragEnd}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 0',
        borderTop: over ? '2px solid ' + BRAND.blue : '1px solid ' + BRAND.border,
        background: over ? '#F4FBFE' : 'transparent', opacity: dragging ? 0.4 : 1,
      }}
    >
      <span title="Drag to reorder" style={{ flexShrink: 0, cursor: 'grab', color: BRAND.muted, display: 'flex', lineHeight: 0 }}><GripVertical size={14} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {e.description}
          {e.vattable && <span title="Marked vattable" style={{ fontSize: 10, fontWeight: 700, color: '#7C3AED', background: '#F3E8FF', border: '1px solid #E9D5FF', padding: '1px 5px', borderRadius: 999, marginLeft: 6, textTransform: 'uppercase', letterSpacing: 0.3 }}>VAT</span>}
          {e.recurring && <span title="Repeats every month" style={{ fontSize: 10, fontWeight: 700, color: '#0E7490', background: '#ECFEFF', border: '1px solid #A5F3FC', padding: '1px 5px', borderRadius: 999, marginLeft: 6, textTransform: 'uppercase', letterSpacing: 0.3 }}>Recurring</span>}
        </div>
        {e.recurring ? <div style={{ fontSize: 11, color: BRAND.muted }}>Every month</div> : (e.spentOn && <div style={{ fontSize: 11, color: BRAND.muted }}>{e.spentOn}</div>)}
      </div>
      <span style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink, flexShrink: 0, minWidth: 56, textAlign: 'right' }}>{formatGBP(e.amount)}</span>
      <input ref={fileRef} type="file" accept="image/*,application/pdf" style={{ display: 'none' }} onChange={(ev) => { onPick(ev.target.files?.[0]); ev.target.value = ''; }} />
      {e.hasInvoice ? (
        <>
          <button className="btn-icon" title={`Download ${e.filename || 'invoice'}`} onClick={download} style={{ padding: 3, color: '#15803D' }}><Paperclip size={13} /></button>
          <button className="btn-icon" title="Remove invoice" onClick={removeFile} style={{ padding: 3 }}><X size={12} /></button>
        </>
      ) : (
        <button className="btn-icon" title="Attach invoice / receipt" onClick={() => fileRef.current?.click()} disabled={busy} style={{ padding: 3, color: BRAND.muted }}>
          <Paperclip size={13} />
        </button>
      )}
      {e.recurring && (
        <button className="btn-icon" title="Stop this recurring expense from this month onward (keeps earlier months)" onClick={stopRecurring} style={{ padding: 3, color: '#B45309' }}><Ban size={12} /></button>
      )}
      <button className="btn-icon" title={e.recurring ? 'Delete entirely (all months)' : 'Delete expense'} onClick={remove} style={{ padding: 3 }}><Trash2 size={12} /></button>
    </div>
  );
}

function DirExpenseForm({ directorEmail, actions, showMsg, onDone, onCancel }) {
  const isMobile = useIsMobile();
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [spentOn, setSpentOn] = useState(() => todayKey());
  const [vattable, setVattable] = useState(false);
  const [recurring, setRecurring] = useState(false);
  const [file, setFile] = useState(null); // receipt chosen before saving
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const cameraRef = useRef(null);

  const submit = async () => {
    if (!description.trim() || busy) return;
    setBusy(true);
    try {
      const id = await actions.addDirectorExpense({ director_email: directorEmail, description: description.trim(), amount: parseFloat(amount) || 0, spentOn, vattable, recurring });
      if (file && id) {
        try { await actions.uploadDirectorInvoice(id, file); }
        catch (err) { showMsg?.(err.message || 'Expense saved, but the receipt upload failed', 'error'); }
      }
      onDone();
    } finally { setBusy(false); }
  };

  return (
    <div style={{ background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 8, padding: 10, margin: '4px 0 8px' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input autoFocus placeholder="What was it? (e.g. Fuel, Parking)" value={description} onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          style={{ flex: 1, minWidth: 140, padding: '6px 10px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 13 }} />
        <span style={{ color: BRAND.muted }}>£</span>
        <input type="number" step="0.01" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          style={{ width: 96, padding: '6px 10px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 13 }} />
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
        <input type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 13 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: BRAND.ink, cursor: 'pointer' }}>
          <input type="checkbox" checked={vattable} onChange={(e) => setVattable(e.target.checked)} /> Vattable
        </label>
        <label title="Repeats automatically every month from this one onward" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: BRAND.ink, cursor: 'pointer' }}>
          <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} /> Recurring
        </label>
      </div>

      {/* Receipt — attach a file (or, on mobile, snap a photo) before saving. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
        <input ref={fileRef} type="file" accept="image/*,application/pdf" style={{ display: 'none' }} onChange={(e) => { if (e.target.files?.[0]) setFile(e.target.files[0]); }} />
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => { if (e.target.files?.[0]) setFile(e.target.files[0]); }} />
        <button className="btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => fileRef.current?.click()}><Paperclip size={13} /> {file ? 'Change receipt' : 'Attach receipt'}</button>
        {isMobile && (
          <button className="btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => cameraRef.current?.click()}><Camera size={13} /> Photo</button>
        )}
        {file && (
          <span style={{ fontSize: 12, color: BRAND.muted, display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {file.name}
            <button className="btn-icon" title="Remove receipt" onClick={() => setFile(null)} style={{ padding: 1 }}><X size={11} /></button>
          </span>
        )}
        <button className="btn-ghost" style={{ padding: '4px 8px', marginLeft: 'auto' }} onClick={onCancel}><X size={13} /></button>
        <button className="btn" style={{ padding: '5px 10px' }} onClick={submit} disabled={!description.trim() || busy}><Check size={13} /> {busy ? 'Saving…' : 'Add'}</button>
      </div>
    </div>
  );
}

const VAT_COLOR_CF = '#F59E0B';

function CfMini({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || BRAND.ink }}>{value}</div>
    </div>
  );
}

// The three monthly revenue targets, headlined on the Cash Flow & Targets tab.
// "Minimum" is the full cost base (break-even). The £4k/£5k targets are what you
// must bill so both directors can draw that wage — each director's wage baseline
// is £3,000/mo (Adam's £3,500 drawing less his £500 car allowance), both get the
// same uplift, and the figure grosses up the extra income tax + NI on it.
function CfTargets({ targets, isMobile }) {
  const draws = Array.isArray(targets.draws) ? targets.draws : [];
  const cards = [
    { key: 'min', label: 'Minimum Target', value: targets.minimum, sub: 'Composed of all expenses & wages', accent: BRAND.muted },
    ...draws.map((d) => ({
      key: 'd' + d.draw,
      label: `£${(d.draw / 1000)}k take-home target`,
      value: d.amount,
      sub: `Both directors take home £${d.draw.toLocaleString('en-GB')}/mo after tax (business funds the tax)`,
      accent: BRAND.blue,
    })),
  ];
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderLeft: `3px solid ${BRAND.blue}`, borderRadius: 10, padding: isMobile ? 14 : '14px 18px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>
        <Target size={14} color={BRAND.blue} /> Monthly revenue targets
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 12 }}>
        {cards.map((c) => (
          <div key={c.key} style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, padding: '12px 14px', background: '#FBFCFE' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.ink, marginBottom: 4 }}>{c.label}</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: c.accent, lineHeight: 1.1, marginBottom: 6 }}>{formatGBP(c.value)}</div>
            <div style={{ fontSize: 12, color: BRAND.muted, lineHeight: 1.35 }}>{c.sub}</div>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 12, color: BRAND.muted, margin: '12px 0 0' }}>
        Take-home (net) targets, based on Adam — each director keeps this much after tax (Ben’s pay is a composite of his + Anna’s salaries less his car lease, so it mirrors Adam). Baseline {formatGBP(targets.baseline)}/mo; Adam’s £500 car allowance is excluded from the wage but still taxed. The business funds the income tax + employee NI so the take-home is clean — added on top of the minimum (which already funds today’s drawings). Estimate only.
      </p>
    </div>
  );
}

// Two visually separate panels — Expenses and Wages — each with its own add
// form, totals and per-row reordering. Wages is deliberately split out from the
// rest so payroll reads as its own block.
function CfCosts({ lines, month, monthLabel, actions, reload, isMobile }) {
  const wages = lines.filter((l) => l.category === 'wages');
  const freelancers = lines.filter((l) => l.category === 'freelancer');
  const marketing = lines.filter((l) => l.category === 'marketing');
  const directors = lines.filter((l) => l.category === 'director');
  const allowances = lines.filter((l) => l.category === 'allowance');
  const expenses = lines.filter((l) => !['wages', 'freelancer', 'marketing', 'director', 'allowance'].includes(l.category));
  return (
    <>
      <CfCostPanel title="Expenses" icon={Receipt} accent="#0E7490" category="expense"
        rows={expenses} month={month} monthLabel={monthLabel} actions={actions} reload={reload} isMobile={isMobile} />
      <CfCostPanel title="Marketing" icon={Megaphone} accent="#F97316" category="marketing"
        rows={marketing} month={month} monthLabel={monthLabel} actions={actions} reload={reload} isMobile={isMobile} />
      <CfCostPanel title="Staff Wages" icon={Users} accent={BRAND.blue} category="wages"
        rows={wages} month={month} monthLabel={monthLabel} actions={actions} reload={reload} isMobile={isMobile} />
      <CfCostPanel title="Freelancer Costs" icon={Briefcase} accent="#8B5CF6" category="freelancer"
        rows={freelancers} month={month} monthLabel={monthLabel} actions={actions} reload={reload} isMobile={isMobile} />
      <CfCostPanel title="Directors" icon={Crown} accent="#CA8A04" category="director"
        rows={directors} month={month} monthLabel={monthLabel} actions={actions} reload={reload} isMobile={isMobile} />
      <CfCostPanel title="Director Allowances" icon={Coins} accent="#D97706" category="allowance"
        rows={allowances} month={month} monthLabel={monthLabel} actions={actions} reload={reload} isMobile={isMobile} />
    </>
  );
}

function CfCostPanel({ title, icon: Icon, accent, category, rows, month, monthLabel, actions, reload, isMobile }) {
  const [adding, setAdding] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const total = rows.reduce((s, r) => s + (Number(r.monthlyAmount ?? r.amount) || 0), 0);

  const onDrop = () => {
    if (dragId && overId && dragId !== overId) {
      const ids = rows.map((r) => r.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(overId);
      if (from >= 0 && to >= 0) {
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        actions.reorderCashflowCosts(ids).then(reload);
      }
    }
    setDragId(null); setOverId(null);
  };

  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderLeft: `3px solid ${accent}`, borderRadius: 12, padding: isMobile ? 12 : '12px 18px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6, display: 'flex', alignItems: 'center', gap: 6 }}>
          {Icon && <Icon size={14} color={accent} />} {title} — {monthLabel}
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: BRAND.ink }}>{formatGBP(total)}<span style={{ fontSize: 11, fontWeight: 500, color: BRAND.muted }}> /mo</span></span>
          <button className="btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => setAdding((v) => !v)}><Plus size={13} /> Add</button>
        </div>
      </div>

      {adding && <CfCostForm month={month} category={category} onDone={() => { setAdding(false); reload(); }} onCancel={() => setAdding(false)} actions={actions} />}

      {rows.length === 0 && !adding ? (
        <div style={{ color: BRAND.muted, fontSize: 13, padding: '4px 0' }}>No {title.toLowerCase()} for {monthLabel}.</div>
      ) : (
        rows.map((r) => (
          <CfCostRow key={r.id} row={r} actions={actions} reload={reload}
            dragging={dragId === r.id} over={overId === r.id && dragId !== r.id}
            onDragStart={() => setDragId(r.id)} onDragOver={() => setOverId(r.id)}
            onDrop={onDrop} onDragEnd={() => { setDragId(null); setOverId(null); }} />
        ))
      )}
    </div>
  );
}

// Per-row frequency label so it's clear at a glance whether the figure is the
// raw monthly cost or an annual cost spread across 12 months.
function CfFreqTag({ row }) {
  const annual = row.frequency === 'annual';
  return (
    <span
      title={annual ? `Annual cost of ${formatGBP(row.amount)}/yr — counted as ${formatGBP(row.monthlyAmount)}/month` : 'Monthly cost'}
      style={{
        flexShrink: 0, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4,
        padding: '1px 6px', borderRadius: 999,
        color: annual ? '#7C3AED' : BRAND.muted,
        background: annual ? '#F3E8FF' : BRAND.paper,
        border: '1px solid ' + (annual ? '#E9D5FF' : BRAND.border),
      }}
    >
      {annual ? 'Annual ÷12' : 'Monthly'}
    </span>
  );
}

function CfCostRow({ row, actions, reload, dragging, over, onDragStart, onDragOver, onDrop, onDragEnd }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(row.label);
  const [amount, setAmount] = useState(String(row.amount));
  const [frequency, setFrequency] = useState(row.frequency || 'monthly');
  const [category, setCategory] = useState(row.category || 'expense');
  const [note, setNote] = useState(row.note || '');
  const [taxBasis, setTaxBasis] = useState(!!row.taxBasis);

  const isAuto = !!row.autoType;
  const isCorpTax = row.autoType === 'corp_tax';
  const isDirExp = row.autoType === 'director_expenses'; // synthetic Directors-tab total
  const isReadOnly = isCorpTax || isDirExp; // no drag / edit / remove

  const save = () => {
    const before = { label: row.label, amount: Number(row.amount) || 0, frequency: row.frequency || 'monthly', category: row.category || 'expense', note: row.note || '', taxBasis: !!row.taxBasis };
    actions.updateCashflowCost(row.id, { label: label.trim() || row.label, amount: parseFloat(amount) || 0, frequency, category, note: note.trim(), taxBasis }, before).then(() => { setEditing(false); reload(); });
  };
  const remove = () => actions.deleteCashflowCost(row.id, row).then(reload);
  const reset = () => { setEditing(false); setLabel(row.label); setAmount(String(row.amount)); setFrequency(row.frequency || 'monthly'); setCategory(row.category || 'expense'); setNote(row.note || ''); setTaxBasis(!!row.taxBasis); };

  if (editing) {
    const monthlyEst = frequency === 'annual' ? (parseFloat(amount) || 0) / 12 : null;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', borderTop: '1px solid ' + BRAND.border, flexWrap: 'wrap' }}>
        <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') reset(); }}
          style={{ flex: 1, minWidth: 120, padding: '4px 8px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 13 }} />
        {isAuto ? (
          <span style={{ fontSize: 12, color: BRAND.muted }}>= {formatGBP(row.monthlyAmount ?? 0)}/mo (auto)</span>
        ) : (
          <>
            <span style={{ color: BRAND.muted }}>£</span>
            <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
              style={{ width: 96, padding: '4px 8px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 13 }} />
            <Segmented value={frequency} onChange={setFrequency} options={[{ value: 'monthly', label: '/mo' }, { value: 'annual', label: '/yr' }]} />
          </>
        )}
        <Segmented value={category} onChange={setCategory} options={[{ value: 'expense', label: 'Exp' }, { value: 'marketing', label: 'Mktg' }, { value: 'wages', label: 'Staff' }, { value: 'freelancer', label: 'Free' }, { value: 'director', label: 'Dir' }, { value: 'allowance', label: 'Allow' }]} />
        {category === 'director' && !isAuto && (
          <label title="Include this director's pay in the auto personal-tax saving" style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: BRAND.ink, cursor: 'pointer' }}>
            <input type="checkbox" checked={taxBasis} onChange={(e) => setTaxBasis(e.target.checked)} /> tax
          </label>
        )}
        {monthlyEst != null && <span style={{ fontSize: 11, color: BRAND.muted }}>≈{formatGBP(monthlyEst)}/mo</span>}
        <button className="btn-icon" title="Save" onClick={save}><Check size={13} /></button>
        <button className="btn-icon" title="Cancel" onClick={reset}><X size={13} /></button>
        <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') reset(); }}
          style={{ flexBasis: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 13 }} />
      </div>
    );
  }

  return (
    <div
      draggable={!isReadOnly}
      onDragStart={isReadOnly ? undefined : (e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragOver={isReadOnly ? undefined : (e) => { e.preventDefault(); onDragOver(); }}
      onDrop={isReadOnly ? undefined : (e) => { e.preventDefault(); onDrop(); }}
      onDragEnd={isReadOnly ? undefined : onDragEnd}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: isCorpTax ? '5px 8px' : '3px 0',
        borderTop: over ? '2px solid ' + BRAND.blue : '1px solid ' + BRAND.border,
        background: isCorpTax ? '#FEF9C3' : (over ? '#F4FBFE' : 'transparent'),
        borderLeft: isCorpTax ? '3px solid ' + VAT_COLOR_CF : undefined,
        borderRadius: isCorpTax ? 6 : 0, opacity: dragging ? 0.4 : 1,
      }}
    >
      {isCorpTax
        ? <span style={{ flexShrink: 0, color: VAT_COLOR_CF, display: 'flex', lineHeight: 0 }}><PiggyBank size={14} /></span>
        : isDirExp
          ? <span style={{ flexShrink: 0, color: '#CA8A04', display: 'flex', lineHeight: 0 }}><Crown size={14} /></span>
          : <span title="Drag to reorder" style={{ flexShrink: 0, cursor: 'grab', color: BRAND.muted, display: 'flex', lineHeight: 0 }}><GripVertical size={14} /></span>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: isCorpTax ? 700 : 400, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {row.label}
          {row.taxBasis && <span title="Counts toward the auto director personal-tax saving" style={{ fontSize: 11, color: BRAND.muted }}> · feeds director tax</span>}
          {!row.recurring && !isCorpTax && <span style={{ fontSize: 11, color: BRAND.muted }}> · one-off {row.month}</span>}
        </div>
        {isCorpTax
          ? <div title="HMRC marginal-relief Corporation Tax on this month’s operating profit (19% up to £50k, 25% over £250k, tapered). Also shown as the headline card above; included here so the targets cover it. A loss month sets aside nothing." style={{ fontSize: 11, color: '#92400E', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>⚙ Auto — to set aside on this month’s profit (HMRC marginal relief); counted in the targets</div>
          : isDirExp
            ? <div title="Combined director expenses logged on the Directors tab for this month — counted in the costs and targets." style={{ fontSize: 11, color: '#92400E', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>⚙ Auto — combined spend from the Directors tab; counted in the totals</div>
            : isAuto
            ? <div title="Income tax + employee NI on each director's drawings marked “feeds director tax” (2025/26 rates), treating the figure as gross salary" style={{ fontSize: 11, color: '#CA8A04', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>⚙ Auto — income tax + NI on the director pay marked “feeds director tax” (current rates){row.note ? ` · ${row.note}` : ''}</div>
            : (row.note && <div title={row.note} style={{ fontSize: 11, color: BRAND.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.note}</div>)}
      </div>
      {isAuto
        ? <span title="Auto-calculated — not editable directly" style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, padding: '1px 6px', borderRadius: 999, color: '#CA8A04', background: isCorpTax ? '#FDE68A' : '#FEF9C3', border: '1px solid #FDE68A' }}>Auto</span>
        : <CfFreqTag row={row} />}
      {row.frequency === 'annual' && <span style={{ fontSize: 11, color: BRAND.muted, flexShrink: 0 }}>{formatGBP(row.amount)}/yr</span>}
      <span style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink, flexShrink: 0, minWidth: 64, textAlign: 'right' }}>{formatGBP(row.monthlyAmount ?? row.amount)}</span>
      {isReadOnly ? (
        <span style={{ flexShrink: 0, width: 48 }} />
      ) : (
        <>
          <button className="btn-icon" title="Edit" onClick={() => setEditing(true)} style={{ padding: 3 }}><Pencil size={12} /></button>
          <button className="btn-icon" title="Remove" onClick={remove} style={{ padding: 3 }}><Trash2 size={12} /></button>
        </>
      )}
    </div>
  );
}

function CfCostForm({ month, category, onDone, onCancel, actions }) {
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [recurring, setRecurring] = useState(true);
  const [frequency, setFrequency] = useState('monthly');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = () => {
    if (!label.trim() || busy) return;
    setBusy(true);
    const payload = {
      label: label.trim(), amount: parseFloat(amount) || 0, category, frequency, recurring, note: note.trim(),
      ...(recurring ? { effectiveFrom: month } : { month }),
    };
    actions.addCashflowCost(payload).then(onDone).finally(() => setBusy(false));
  };

  const monthlyEst = frequency === 'annual' ? (parseFloat(amount) || 0) / 12 : null;

  return (
    <div style={{ background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 8, padding: 10, margin: '4px 0 8px' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input autoFocus placeholder={category === 'wages' ? 'Who? (e.g. Callum, Chloe)' : category === 'freelancer' ? 'Who? (e.g. Lesley, Freelance editor)' : category === 'marketing' ? 'What is it? (e.g. PPC, Agency fee)' : category === 'director' ? 'Who/what? (e.g. Adam, pension, car)' : category === 'allowance' ? 'Who? (e.g. Adam allowance)' : 'What is it? (e.g. Office rent)'} value={label} onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          style={{ flex: 1, minWidth: 160, padding: '6px 10px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 13 }} />
        <span style={{ color: BRAND.muted }}>£</span>
        <input type="number" step="0.01" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          style={{ width: 110, padding: '6px 10px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 13 }} />
        <Segmented value={frequency} onChange={setFrequency} options={[{ value: 'monthly', label: 'Monthly' }, { value: 'annual', label: 'Annual' }]} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: BRAND.ink, cursor: 'pointer' }}>
          <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} />
          {recurring ? 'Recurring' : `One-off (${monthOptionLabel(month)})`}
        </label>
        <button className="btn-ghost" style={{ padding: '4px 8px' }} onClick={onCancel}><X size={13} /></button>
        <button className="btn" style={{ padding: '5px 10px' }} onClick={submit} disabled={!label.trim() || busy}><Check size={13} /> {busy ? 'Adding…' : 'Add'}</button>
      </div>
      <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        style={{ width: '100%', boxSizing: 'border-box', marginTop: 8, padding: '6px 10px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 13 }} />
      {monthlyEst != null && (
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 8 }}>
          Annual cost — counted as <strong style={{ color: BRAND.ink }}>{formatGBP(monthlyEst)}/month</strong> (£{(parseFloat(amount) || 0).toLocaleString('en-GB')} ÷ 12).
        </div>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub, accent }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderLeft: `3px solid ${accent || BRAND.blue}`, borderRadius: 10, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
        {Icon && <Icon size={14} color={accent || BRAND.muted} />}
        <span>{label}</span>
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: BRAND.ink }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

const MONTH_ABBR = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Parse a sheet "Month" cell into 'YYYY-MM'. Accepts 'Sep-16', 'Sep 2016',
// 'Mar23', 'September 2016', '2016-09'. Returns null if unrecognised.
function parseMonthCell(raw) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}/.test(s)) return s.slice(0, 7);
  const m = s.match(/^([A-Za-z]{3,})[-\s/]*(\d{2,4})$/);
  if (m) {
    const mi = MONTH_ABBR[m[1].slice(0, 3).toLowerCase()];
    if (mi) {
      let y = Number(m[2]);
      if (y < 100) y += 2000;
      return `${y}-${String(mi).padStart(2, '0')}`;
    }
  }
  return null;
}

const parseMoney = (raw) => Number(String(raw ?? '').replace(/[£,\s]/g, '')) || 0;

// Parse pasted TSV/CSV (Month, Sales, PP's) into normalised history rows,
// skipping a header row and anything without a recognisable month.
function parseHistoryPaste(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split(/\t|,/).map((c) => c.trim());
    const month = parseMonthCell(cells[0]);
    if (!month) continue;
    out.push({ month, sales: parseMoney(cells[1]), pps: parseMoney(cells[2]) });
  }
  return out;
}

function ImportHistoryPanel({ actions, history, isMobile }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [mode, setMode] = useState('merge');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => { if (open && history == null) actions.loadSalesHistory(); }, [open, history, actions]);

  const parsed = useMemo(() => parseHistoryPaste(text), [text]);

  const submit = async () => {
    if (!parsed.length || busy) return;
    setBusy(true); setResult(null);
    try {
      const data = await actions.importSalesHistory(parsed, mode);
      await actions.loadTrend(36);
      setResult({ ok: true, saved: data?.saved ?? parsed.length });
      setText('');
    } catch {
      setResult({ ok: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 12 : 20 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
      >
        <ChevronDown size={16} color={BRAND.muted} style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          Import Live Sales Sheet history
        </span>
        {history && history.length > 0 && (
          <span style={{ fontSize: 12, color: BRAND.muted, fontWeight: 500 }}>· {history.length} months stored</span>
        )}
      </button>

      {open && (
        <div style={{ marginTop: 14 }}>
          <p style={{ margin: '0 0 10px', fontSize: 12, color: BRAND.muted }}>
            Paste three columns — <strong>Month, Sales (cash in), PP's (money owed)</strong> — straight from the sheet (tab or comma separated).
            Months are read as <code>Sep-16</code> or <code>2016-09</code>; a header row is ignored. These override the computed figures for those months.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'Sep-16\t6695\t1130\nOct-16\t5838\t1650\n…'}
            rows={8}
            style={{ width: '100%', boxSizing: 'border-box', padding: 10, borderRadius: 8, border: '1px solid ' + BRAND.border, fontSize: 13, fontFamily: 'monospace', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: BRAND.ink, cursor: 'pointer' }}>
              <input type="radio" checked={mode === 'merge'} onChange={() => setMode('merge')} /> Merge (update/add)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: BRAND.ink, cursor: 'pointer' }}>
              <input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /> Replace all
            </label>
            <span style={{ fontSize: 12, color: BRAND.muted }}>{parsed.length} {parsed.length === 1 ? 'month' : 'months'} detected</span>
            <button onClick={submit} className="btn" disabled={!parsed.length || busy} style={{ marginLeft: 'auto' }}>
              {busy ? 'Importing…' : 'Import history'}
            </button>
          </div>
          {result && (
            <div style={{ marginTop: 10, fontSize: 13, color: result.ok ? '#15803D' : '#EF4444' }}>
              {result.ok ? `Imported ${result.saved} months — charts updated.` : 'Import failed — please try again.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Segmented({ value, onChange, options, big }) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid ' + BRAND.border, borderRadius: big ? 10 : 8, overflow: 'hidden', background: 'white' }}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{
            padding: big ? '10px 22px' : '8px 14px', border: 'none', cursor: 'pointer', fontSize: big ? 15 : 14,
            fontWeight: value === o.value ? 600 : 500,
            background: value === o.value ? BRAND.blue : 'white',
            color: value === o.value ? 'white' : BRAND.ink,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function PaceCard({ title, big, sub, color, accent }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderLeft: accent ? `3px solid ${accent}` : '1px solid ' + BRAND.border, borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || BRAND.ink }}>{big}</div>
      <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>{sub}</div>
    </div>
  );
}

// What's still needed to reach each target, plus the daily run-rate required
// across the working days remaining in the period. Recomputes live as days pass
// and cash comes in (model.netSoFar / lastActualIdx drive it).
function RemainingCard({ targets, model, isSales, isMobile }) {
  const daysLeft = Math.max(0, model.N - model.lastActualIdx);
  const noun = isSales ? 'sign' : 'bank';
  const header = model.status === 'complete'
    ? 'Period complete'
    : `${daysLeft} working ${daysLeft === 1 ? 'day' : 'days'} left`;
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: isMobile ? 14 : '14px 18px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Remaining to make targets</span>
        <span style={{ fontSize: 12, color: BRAND.muted }}>{header}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {targets.map((t, i) => {
          const target = (Number(t.amount) || 0) * model.spanMonths;
          const remaining = Math.max(0, target - model.netSoFar);
          const met = remaining <= 0.005;
          const perDay = daysLeft > 0 ? remaining / daysLeft : null;
          return (
            <div
              key={t.key}
              style={{
                display: 'grid',
                gridTemplateColumns: isMobile ? '1fr auto' : '1.3fr 1fr 1fr',
                gap: 8, alignItems: 'center',
                padding: '8px 0', borderTop: i === 0 ? 'none' : '1px solid ' + BRAND.border,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: t.color, flexShrink: 0 }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.label}</span>
                <span style={{ fontSize: 12, color: BRAND.muted, flexShrink: 0 }}>{formatGBP(target)}</span>
              </div>
              {met ? (
                <div style={{ gridColumn: isMobile ? '2' : '2 / span 2', textAlign: 'right', fontSize: 13, fontWeight: 700, color: '#10B981' }}>
                  Target met ✓
                </div>
              ) : (
                <>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink }}>{formatGBP(remaining)}</div>
                    {!isMobile && <div style={{ fontSize: 11, color: BRAND.muted }}>still to {noun}</div>}
                  </div>
                  {!isMobile && (
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.blue }}>
                        {perDay != null ? formatGBP(perDay) : '—'}
                      </div>
                      <div style={{ fontSize: 11, color: BRAND.muted }}>{perDay != null ? 'per working day' : 'no days left'}</div>
                    </div>
                  )}
                </>
              )}
              {isMobile && !met && (
                <div style={{ gridColumn: '1 / span 2', textAlign: 'right', fontSize: 11, color: BRAND.muted, marginTop: -4 }}>
                  {perDay != null ? `${formatGBP(perDay)} per working day` : 'no working days left'}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TargetEditor({ targets, onSave, onCancel, heading = 'Monthly targets', amountsLocked = false }) {
  const [rows, setRows] = useState(() => targets.map((t) => ({ ...t })));
  const set = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink, marginBottom: 12 }}>{heading}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r, i) => (
          <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: r.color, flexShrink: 0 }} />
            <input
              value={r.label}
              onChange={(e) => set(i, { label: e.target.value })}
              style={{ width: 140, padding: '6px 8px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 14 }}
            />
            <span style={{ color: BRAND.muted }}>£</span>
            <input
              type="number"
              step="0.01"
              value={r.amount}
              readOnly={amountsLocked}
              onChange={(e) => set(i, { amount: parseFloat(e.target.value) || 0 })}
              style={{ width: 140, padding: '6px 8px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 14, background: amountsLocked ? '#F8FAFC' : 'white', color: amountsLocked ? BRAND.muted : BRAND.ink }}
            />
            <span style={{ fontSize: 12, color: BRAND.muted }}>/ month (ex-VAT)</span>
          </div>
        ))}
      </div>
      {amountsLocked && (
        <p style={{ fontSize: 12, color: BRAND.muted, margin: '12px 0 0' }}>
          Amounts come from the <strong>Cash Flow &amp; Targets</strong> tab (Minimum / £4k / £5k) and update automatically as your costs change — edit the labels here, change the figures there.
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
        <button onClick={onCancel} className="btn-ghost"><X size={14} /> Cancel</button>
        <button onClick={() => onSave(rows)} className="btn"><Check size={14} /> Save targets</button>
      </div>
    </div>
  );
}
