import React, { useEffect, useMemo, useState } from 'react';
import { TrendingUp, Pencil, Check, X, Wallet, PoundSterling, ChevronDown, Plus, Trash2, Receipt, Landmark, PiggyBank, Calculator, Users, GripVertical, Briefcase } from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, useIsMobile, workingDaysBetween, ukBankHolidays, todayKey, formatRelativeTime } from '../../utils.js';

const PPS_COLOR = '#F59E0B';
// 'YYYY-MM' → "Jun '24" (the trailing window spans up to 3 years).
const monthShortYear = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'short' }) + " '" + String(y).slice(2);
};

// Fallback if settings hasn't loaded targets yet (matches api/settings.js seed).
const FALLBACK_TARGETS = [
  { key: 'minimum', label: 'Minimum', amount: 27806.92, color: '#F59E0B' },
  { key: 't4k', label: '4k', amount: 30606.92, color: '#94A3B8' },
  { key: 'dream', label: 'Dream 5k', amount: 33406.92, color: '#EAB308' },
];

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
export function PerformancePanel({ section: sectionProp, onSection } = {}) {
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

  useEffect(() => {
    if (!state.bankHolidays) actions.loadBankHolidays();
  }, [actions, state.bankHolidays]);

  // Reload when the period/section changes OR when finance data changes elsewhere
  // (e.g. a PP marked paid bumps state.financeRefresh) so the pace chart stays live.
  useEffect(() => {
    if (isComparison || isCashflow) { setLoading(false); return; } // pacing stats not needed here
    let active = true;
    setLoading(true);
    const load = isSales ? actions.loadSalesStats(period) : actions.loadPerformanceStats(period);
    load.finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [actions, period, isSales, isComparison, isCashflow, state.financeRefresh]);

  // Sales vs PP's needs the rolling 36-month trend + (for the importer) history.
  // Refetch the trend too when finance data changes.
  useEffect(() => {
    if (isComparison) actions.loadTrend(36);
  }, [actions, isComparison, state.financeRefresh]);

  const targetSource = isSales ? state.salesTargets : state.financeTargets;
  const targets = (targetSource && targetSource.length) ? targetSource : FALLBACK_TARGETS;
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

    const data = workingDays.map((wd, i) => {
      const dayNum = i + 1;
      const point = { day: dayNum };
      point.actual = dayNum <= lastActualIdx ? Number(cumTo(wd).toFixed(2)) : null;
      for (const t of targets) point[t.key] = Number(((Number(t.amount) || 0) * spanMonths * dayNum / N).toFixed(2));
      return point;
    });

    const netSoFar = lastActualIdx > 0 ? cumTo(workingDays[lastActualIdx - 1]) : 0;
    const projected = lastActualIdx > 0 ? (netSoFar / lastActualIdx) * N : 0;

    return { N, lastActualIdx, data, netSoFar, projected, status, spanMonths, label };
  }, [perf, period, targets, holidays]);

  return (
    <section style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <TrendingUp size={20} color={BRAND.blue} />
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Performance</h2>
            <p style={{ fontSize: 13, color: BRAND.muted, margin: '2px 0 0' }}>
              {isCashflow
                ? 'Company costs vs cash received — each month’s profit, the Corporation Tax to set aside (HMRC marginal relief), and a suggested revenue target.'
                : isComparison
                  ? "Cash received each month vs new money owed created that month (ex-VAT), over the last 36 months. The latest owed point previews all outstanding cash still to collect (invoiced or not)."
                  : isSales
                    ? 'New business signed (ex-VAT) across all customers, paced against your sales targets by working day.'
                    : 'Cash received (ex-VAT) across all customers, paced against your income targets by working day.'}
            </p>
          </div>
        </div>
        {!isComparison && !isCashflow && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setEditing((v) => !v)} className="btn-ghost" title="Edit targets">
              <Pencil size={14} /> Targets
            </button>
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
          options={[{ value: 'income', label: 'Income performance' }, { value: 'sales', label: 'Sales performance' }, { value: 'salesvspp', label: "Sales vs PP's" }, { value: 'cashflow', label: 'Cash Flow' }]}
        />
      </div>

      {isComparison && (
        <SalesVsPpView trend={state.trend} isMobile={isMobile} actions={actions} history={state.salesHistory} />
      )}

      {isCashflow && (
        <CashFlowView isMobile={isMobile} />
      )}

      {!isComparison && !isCashflow && editing && (
        <TargetEditor
          key={section}
          heading={isSales ? 'Monthly sales targets' : 'Monthly income targets'}
          targets={targets}
          onSave={(list) => { (isSales ? actions.saveSalesTargets(list) : actions.saveFinanceTargets(list)); setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      )}

      {/* Pace strip: where you are today vs each target's expected pace. */}
      {!isComparison && !isCashflow && (<>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : `repeat(${targets.length + 1}, 1fr)`, gap: 12, marginBottom: 16 }}>
        <PaceCard
          title={model.status === 'future' ? 'Upcoming period' : `Working day ${model.lastActualIdx} of ${model.N}`}
          big={formatGBP(model.netSoFar)}
          sub={model.status === 'in_progress'
            ? `${isSales ? 'Signed' : 'Net banked'} so far · projected ${formatGBP(model.projected)} by end`
            : (model.status === 'complete' ? `${isSales ? 'Signed' : 'Net banked'} (final)` : `No ${isSales ? 'sales' : 'cash'} yet`)}
          color={BRAND.blue}
        />
        {targets.map((t) => {
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
function SalesVsPpView({ trend, isMobile, actions, history }) {
  const months = trend?.months || [];
  const chart = useMemo(() => months.map((m, i) => ({
    label: monthShortYear(m.month),
    cashIn: m.cashIn,
    // The latest point previews ALL outstanding cash still owed (invoiced or
    // not), not just what was created that month.
    pps: (i === months.length - 1 && m.ppsOutstanding != null) ? m.ppsOutstanding : m.pps,
  })), [months]);
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

// Cash Flow — company costs vs cash received: each month's profit, the
// Corporation Tax to set aside (HMRC marginal relief on the trailing-12m profit)
// and a suggested revenue target. Its own month picker (independent of the page),
// a costs editor (recurring overheads + one-offs), a 12-month history and an
// activity feed. Admin-only — rides on the Finance page's settings.manage gate.
const cfRound2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const PROFIT_POS = '#10B981';
const PROFIT_NEG = '#EF4444';

function CashFlowView({ isMobile }) {
  const { state, actions } = useStore();
  const [month, setMonth] = useState(() => todayKey().slice(0, 7));

  const reload = () => actions.loadCashflow(month);
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
  const sug = cf.suggested;
  const profitColor = sel.profit >= 0 ? PROFIT_POS : PROFIT_NEG;

  const applyTargets = () => {
    const base = (state.financeTargets && state.financeTargets.length) ? state.financeTargets : FALLBACK_TARGETS;
    const list = base.map((t) => ({ ...t }));
    if (list.length) {
      list[0] = { ...list[0], amount: cfRound2(sug.breakEven) };
      list[list.length - 1] = { ...list[list.length - 1], amount: cfRound2(sug.target) };
    }
    actions.saveFinanceTargets(list);
  };

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
          value={formatGBP(sel.costs)} sub={`Wages ${formatGBP(sel.wages)} · Freelance ${formatGBP(sel.freelancers || 0)} · Expenses ${formatGBP(sel.expenses)}`} />
        <StatCard icon={PiggyBank} accent={VAT_COLOR_CF}
          label={ct.inProfit ? 'Corp Tax to set aside' : 'Corp Tax saving'}
          value={formatGBP(Math.abs(ct.monthReserve))}
          sub={ct.inProfit
            ? `≈${Math.round((ct.effectiveRate || 0) * 100)}% effective · this month`
            : 'This month’s loss reduces your CT'} />
      </div>

      {/* Corporation Tax — running 12-month estimate. */}
      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderLeft: `3px solid ${VAT_COLOR_CF}`, borderRadius: 10, padding: isMobile ? 14 : '14px 18px', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
          <Calculator size={14} color={VAT_COLOR_CF} /> Corporation Tax — trailing 12 months
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 12 }}>
          <CfMini label="Profit (12m)" value={formatGBP(ct.profit12)} color={ct.profit12 >= 0 ? PROFIT_POS : PROFIT_NEG} />
          <CfMini label="Cash in (12m)" value={formatGBP(ct.cashIn12)} />
          <CfMini label="Costs (12m)" value={formatGBP(ct.costs12)} />
          <CfMini label="Estimated CT (12m)" value={formatGBP(ct.yearEstimate)} color={VAT_COLOR_CF} />
        </div>
        <p style={{ fontSize: 12, color: BRAND.muted, margin: '12px 0 0' }}>
          HMRC marginal relief: 19% up to £50k profit, 25% over £250k, tapered between. The monthly figure applies the blended {Math.round((ct.effectiveRate || 0) * 100)}% rate to this month’s profit. Estimate only — confirm with your accountant.
        </p>
      </div>

      {/* Suggested revenue target — costs + your profit goal. */}
      <CfSuggested sug={sug} onSaveGoal={(g) => actions.setCashflowProfitGoal(g).then(reload)} onApply={applyTargets} isMobile={isMobile} />

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

const VAT_COLOR_CF = '#F59E0B';

function CfMini({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || BRAND.ink }}>{value}</div>
    </div>
  );
}

function CfSuggested({ sug, onSaveGoal, onApply, isMobile }) {
  const [goal, setGoal] = useState(String(sug.profitGoal || 0));
  useEffect(() => { setGoal(String(sug.profitGoal || 0)); }, [sug.profitGoal]);
  const dirty = (parseFloat(goal) || 0) !== (Number(sug.profitGoal) || 0);
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderLeft: `3px solid ${BRAND.blue}`, borderRadius: 10, padding: isMobile ? 14 : '14px 18px', marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>Suggested monthly revenue target</div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(3, 1fr)', gap: 12, marginBottom: 12 }}>
        <CfMini label="Break-even (cover costs)" value={formatGBP(sug.breakEven)} />
        <CfMini label="Profit goal" value={formatGBP(sug.profitGoal)} />
        <CfMini label="Target (costs + goal)" value={formatGBP(sug.target)} color={BRAND.blue} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, color: BRAND.ink, display: 'flex', alignItems: 'center', gap: 6 }}>
          Monthly profit goal <span style={{ color: BRAND.muted }}>£</span>
          <input type="number" step="0.01" value={goal} onChange={(e) => setGoal(e.target.value)}
            style={{ width: 130, padding: '6px 8px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 14 }} />
        </label>
        <button className="btn-ghost" disabled={!dirty} onClick={() => onSaveGoal(parseFloat(goal) || 0)}>
          <Check size={14} /> Save goal
        </button>
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={onApply} title="Set your Income performance ‘Minimum’ to break-even and the top target to costs + goal">
          Apply to Income targets
        </button>
      </div>
      <p style={{ fontSize: 12, color: BRAND.muted, margin: '10px 0 0' }}>
        Suggestion only — applying overwrites your Income performance targets (Minimum → break-even, top target → costs + goal).
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
  const expenses = lines.filter((l) => l.category !== 'wages' && l.category !== 'freelancer');
  return (
    <>
      <CfCostPanel title="Expenses" icon={Receipt} accent="#0E7490" category="expense"
        rows={expenses} month={month} monthLabel={monthLabel} actions={actions} reload={reload} isMobile={isMobile} />
      <CfCostPanel title="Wages" icon={Users} accent={BRAND.blue} category="wages"
        rows={wages} month={month} monthLabel={monthLabel} actions={actions} reload={reload} isMobile={isMobile} />
      <CfCostPanel title="Freelancer Costs" icon={Briefcase} accent="#8B5CF6" category="freelancer"
        rows={freelancers} month={month} monthLabel={monthLabel} actions={actions} reload={reload} isMobile={isMobile} />
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

  const save = () => actions.updateCashflowCost(row.id, { label: label.trim() || row.label, amount: parseFloat(amount) || 0, frequency, category }).then(() => { setEditing(false); reload(); });
  const remove = () => actions.deleteCashflowCost(row.id).then(reload);
  const reset = () => { setEditing(false); setLabel(row.label); setAmount(String(row.amount)); setFrequency(row.frequency || 'monthly'); setCategory(row.category || 'expense'); };

  if (editing) {
    const monthlyEst = frequency === 'annual' ? (parseFloat(amount) || 0) / 12 : null;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', borderTop: '1px solid ' + BRAND.border, flexWrap: 'wrap' }}>
        <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') reset(); }}
          style={{ flex: 1, minWidth: 120, padding: '4px 8px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 13 }} />
        <span style={{ color: BRAND.muted }}>£</span>
        <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          style={{ width: 96, padding: '4px 8px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 13 }} />
        <Segmented value={frequency} onChange={setFrequency} options={[{ value: 'monthly', label: '/mo' }, { value: 'annual', label: '/yr' }]} />
        <Segmented value={category} onChange={setCategory} options={[{ value: 'expense', label: 'Exp' }, { value: 'wages', label: 'Wages' }, { value: 'freelancer', label: 'Free' }]} />
        {monthlyEst != null && <span style={{ fontSize: 11, color: BRAND.muted }}>≈{formatGBP(monthlyEst)}/mo</span>}
        <button className="btn-icon" title="Save" onClick={save}><Check size={13} /></button>
        <button className="btn-icon" title="Cancel" onClick={reset}><X size={13} /></button>
      </div>
    );
  }

  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragOver={(e) => { e.preventDefault(); onDragOver(); }}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
      onDragEnd={onDragEnd}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0',
        borderTop: over ? '2px solid ' + BRAND.blue : '1px solid ' + BRAND.border,
        background: over ? '#F4FBFE' : 'transparent', opacity: dragging ? 0.4 : 1,
      }}
    >
      <span title="Drag to reorder" style={{ flexShrink: 0, cursor: 'grab', color: BRAND.muted, display: 'flex', lineHeight: 0 }}>
        <GripVertical size={14} />
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {row.label}
        {!row.recurring && <span style={{ fontSize: 11, color: BRAND.muted }}> · one-off {row.month}</span>}
      </span>
      <CfFreqTag row={row} />
      {row.frequency === 'annual' && <span style={{ fontSize: 11, color: BRAND.muted, flexShrink: 0 }}>{formatGBP(row.amount)}/yr</span>}
      <span style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink, flexShrink: 0, minWidth: 64, textAlign: 'right' }}>{formatGBP(row.monthlyAmount ?? row.amount)}</span>
      <button className="btn-icon" title="Edit" onClick={() => setEditing(true)} style={{ padding: 3 }}><Pencil size={12} /></button>
      <button className="btn-icon" title="Remove" onClick={remove} style={{ padding: 3 }}><Trash2 size={12} /></button>
    </div>
  );
}

function CfCostForm({ month, category, onDone, onCancel, actions }) {
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [recurring, setRecurring] = useState(true);
  const [frequency, setFrequency] = useState('monthly');
  const [busy, setBusy] = useState(false);

  const submit = () => {
    if (!label.trim() || busy) return;
    setBusy(true);
    const payload = {
      label: label.trim(), amount: parseFloat(amount) || 0, category, frequency, recurring,
      ...(recurring ? { effectiveFrom: month } : { month }),
    };
    actions.addCashflowCost(payload).then(onDone).finally(() => setBusy(false));
  };

  const monthlyEst = frequency === 'annual' ? (parseFloat(amount) || 0) / 12 : null;

  return (
    <div style={{ background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 8, padding: 10, margin: '4px 0 8px' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input autoFocus placeholder={category === 'wages' ? 'Who? (e.g. Adam, Callum)' : category === 'freelancer' ? 'Who? (e.g. Lesley, Freelance editor)' : 'What is it? (e.g. Office rent)'} value={label} onChange={(e) => setLabel(e.target.value)}
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

function TargetEditor({ targets, onSave, onCancel, heading = 'Monthly targets' }) {
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
              onChange={(e) => set(i, { amount: parseFloat(e.target.value) || 0 })}
              style={{ width: 140, padding: '6px 8px', borderRadius: 6, border: '1px solid ' + BRAND.border, fontSize: 14 }}
            />
            <span style={{ fontSize: 12, color: BRAND.muted }}>/ month (ex-VAT)</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
        <button onClick={onCancel} className="btn-ghost"><X size={14} /> Cancel</button>
        <button onClick={() => onSave(rows)} className="btn"><Check size={14} /> Save targets</button>
      </div>
    </div>
  );
}
