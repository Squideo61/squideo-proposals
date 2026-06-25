import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, PoundSterling, PiggyBank, Wallet, Landmark, ChevronDown, MoreVertical, FileText, ExternalLink, Check, X, Trash2, Link2, RotateCcw, CreditCard, Banknote, CalendarCheck, TrendingUp, Plus, Pencil, StickyNote } from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, formatProposalNumber, useIsMobile } from '../../utils.js';
import { PerformancePanel, resolveIncomeTargets } from './PerformanceView.jsx';
import { CreateXeroInvoiceModal } from './CreateXeroInvoiceModal.jsx';
import { MarkInvoicePaidModal } from './MarkInvoicePaidModal.jsx';
import { Modal } from '../ui.jsx';

const VAT_COLOR = '#F59E0B';
const CT_COLOR = '#0E7490';
const PREDICT_COLOR = '#7C3AED';

// "Predicted this month" plumbing. Any Pending-Payments row can be flagged as a
// payment the user expects to land this calendar month; the flagged set powers
// the Finance "Predicted <month> Payments" tab. Each row computes a stable
// `key` (so the flag survives reloads) + a `label`/`amount` snapshot, and the
// shared context exposes the current flagged-key set + a toggle. Rows read it via
// `usePredict()` and add a single ⋮-menu entry through `predictMenuItem(...)`.
const PredictContext = createContext(null);
const usePredict = () => useContext(PredictContext);
const predictKeyForDeal = (dealId) => `deal:${dealId}`;
const predictKeyForManual = (r) => `${r.kind === 'company-invoice' ? 'companyInvoice' : 'manual'}:${r.id}`;
const predictKeyForPartner = (clientKey) => `partner:${clientKey}`;
// Build the ⋮-menu entry for a row, or null when prediction isn't available
// (no context / no usable key).
function predictMenuItem(predict, item) {
  if (!predict || !item || !item.key) return null;
  const on = predict.keys.has(item.key);
  return {
    label: on ? 'Remove from predicted' : 'Predict this month',
    icon: CalendarCheck,
    onClick: () => predict.toggle(item, !on),
  };
}

// Build the ⋮-menu entry that opens the "expected pay date" picker. Returns
// null when prediction isn't available for the row.
function predictDateMenuItem(predict, item, onOpen) {
  if (!predict || !predict.predictInMonth || !item || !item.key) return null;
  return { label: 'Add predicted pay date', icon: CalendarCheck, onClick: onOpen };
}

// Pick an expected pay date for a pending payment. Predicted lists are
// month-scoped, so the chosen date marks the row predicted in that date's month
// (shown immediately when that's the current month; saved for later otherwise).
function PredictDateModal({ label, onClose, onConfirm }) {
  const { showMsg } = useStore();
  const [date, setDate] = useState('');
  const [saving, setSaving] = useState(false);
  const monthName = date
    ? new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    : '';
  const submit = async (e) => {
    e.preventDefault();
    if (!date || saving) return;
    setSaving(true);
    try {
      await onConfirm(date.slice(0, 7)); // 'YYYY-MM'
      showMsg?.(`Predicted for ${monthName}`);
      onClose();
    } catch (err) {
      showMsg?.(err?.message || 'Could not add predicted date');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal onClose={onClose} dismissible={false} showClose>
      <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700 }}>Add predicted pay date</h2>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: BRAND.muted }}>
        When do you expect {label ? <strong style={{ color: BRAND.ink }}>{label}</strong> : 'this payment'} to be paid?
        It’ll be marked predicted in that month.
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} autoFocus required />
        {monthName && (
          <div style={{ fontSize: 12, color: BRAND.muted }}>
            Will be predicted for <strong style={{ color: BRAND.ink }}>{monthName}</strong>.
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} className="btn-ghost" disabled={saving}>Cancel</button>
          <button type="submit" className="btn" disabled={!date || saving}>{saving ? 'Adding…' : 'Add predicted date'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Resolve the live list of predicted-this-month payments. Signed deals / POs /
// imported rows / company invoices are included only when manually flagged (key
// in `predictKeys`); a flagged item that's no longer pending (paid/removed) drops
// out. **Active partners are always included** (recurring income — predicted by
// default, marked `auto`) until they cancel/unsubscribe (then they're no longer
// in `partners`). Each item carries the ids needed to open its deal/customer/
// partner. Shared by the Predicted tab and the Performance projection. Net
// (ex-VAT) amounts, sorted high→low.
function collectPredicted(pending, partners, predictKeys, excludedKeys) {
  const out = [];
  const seen = new Set();
  const excluded = excludedKeys || new Set();
  // Auto items (partners / other) the user has switched off this month never
  // make the list; manual rows are dropped by un-flagging, so they won't be here.
  const add = (key, it) => { if (!seen.has(key) && !excluded.has(key)) { seen.add(key); out.push({ key, ...it }); } };
  const keys = predictKeys || new Set();
  const p = pending || {};
  for (const d of (p.normal || [])) if (d.dealId && keys.has(predictKeyForDeal(d.dealId))) add(predictKeyForDeal(d.dealId), { name: d.company || d.title || 'Untitled deal', amount: Number(d.outstanding) || 0, source: 'Signed deal', dealId: d.dealId, type: 'deal', row: d, isPo: false });
  for (const d of (p.po || [])) if (d.dealId && keys.has(predictKeyForDeal(d.dealId))) add(predictKeyForDeal(d.dealId), { name: d.company || d.title || 'Untitled deal', amount: Number(d.outstanding) || 0, source: 'Purchase order', dealId: d.dealId, type: 'deal', row: d, isPo: true });
  for (const r of (p.manual || [])) if (keys.has(predictKeyForManual(r))) add(predictKeyForManual(r), { name: r.company || r.description || 'Pending payment', amount: Number(r.amountExVat) || 0, source: r.kind === 'po' ? 'Imported PO' : 'Imported PP', dealId: r.dealId || null, companyId: r.companyId || null, type: 'manual', row: r });
  for (const r of (p.companyInvoices || [])) if (keys.has(predictKeyForManual(r))) add(predictKeyForManual(r), { name: r.company || r.description || 'Company invoice', amount: Number(r.amountExVat) || 0, source: 'Company invoice', companyId: r.companyId || null, type: 'manual', row: r });
  // Active partners ride along automatically (subscription = next month's fee,
  // credits-only = remaining-credit value) — no manual flag needed.
  for (const pt of (partners || [])) if (pt.clientKey) add(predictKeyForPartner(pt.clientKey), { name: pt.clientName || 'Partner', amount: Number(pt.outstanding) || 0, source: 'Partner', clientKey: pt.clientKey, auto: true, type: 'partner', row: pt });
  // "Other" recurring revenue (web hosting etc.) also rides along automatically —
  // it recurs every month, so it's predicted by default like a partner fee.
  for (const r of (p.other || [])) if (r.id) add(`other:${r.id}`, { name: r.label || 'Other', amount: Number(r.amountExVat) || 0, source: 'Other', auto: true, type: 'other', row: r });
  return out.sort((a, b) => b.amount - a.amount);
}
const gbpK = (v) => '£' + Math.round((Number(v) || 0) / 1000) + 'k';
const shortMonth = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'short' });
};

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

function recentMonths(n = 12) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
const monthLongLabel = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
};

// Remembers the Finance page's view state across navigation (e.g. drilling into
// a deal and clicking Back) so it returns to the same tab / Performance toggle /
// period and scroll position instead of resetting to the top. Module-level —
// survives unmount within the SPA session; cleared on a full page reload.
const financeViewMemory = {
  section: 'income', perfSection: 'income', mode: 'month',
  year: null, quarterKey: null, monthKey: null, scrollY: 0,
};

// Reduce a year's monthly stats (financeStats- or salesFinanceStats-shaped) into
// the cards/chart model for the currently selected period. Shared by the Income
// and Sales breakdowns so they render identically.
function buildFinanceView(fin, { mode, qIdx, monthKey, isCurrentYear, monthIdx, effectiveYear }) {
  const months = fin?.months || [];
  const quarters = fin?.quarters || [];
  const yearTotals = months.reduce((a, m) => ({ net: a.net + m.net, vat: a.vat + m.vat, gross: a.gross + m.gross, corpTax: a.corpTax + (m.corpTax || 0) }), { net: 0, vat: 0, gross: 0, corpTax: 0 });

  const zero = { net: 0, vat: 0, gross: 0, corpTax: 0 };
  const displayMonths = mode === 'quarter' ? months.slice(qIdx * 3, qIdx * 3 + 3)
    : mode === 'month' ? months.filter((m) => m.month === monthKey)
    : months;
  const totals = mode === 'quarter' ? (quarters[qIdx] || zero)
    : mode === 'month' ? (months.find((m) => m.month === monthKey) || zero)
    : yearTotals;
  const chart = displayMonths.map((m) => ({ label: shortMonth(m.month), net: m.net, vat: m.vat }));

  const thisMonth = isCurrentYear ? months[monthIdx] : null;
  const thisQuarter = quarters[Math.floor(monthIdx / 3)] || null;
  const periodLabel = mode === 'quarter' ? `Q${qIdx + 1} ${effectiveYear}`
    : mode === 'month' ? monthLongLabel(monthKey)
    : String(effectiveYear);

  return { months, quarters, displayMonths, totals, chart, thisMonth, thisQuarter, periodLabel };
}

export function FinanceView({ onBack, onOpenDeal, onOpenCompany, onOpenPartner }) {
  const { state, actions } = useStore();
  const isMobile = useIsMobile();
  // All CRM companies, shaped for the "link to customer" picker on imported
  // pending-payment rows.
  const companyOptions = Object.values(state.companies || {})
    .filter((c) => c && c.id && c.name)
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const now = new Date();
  const [section, setSection] = useState(financeViewMemory.section); // 'income' | 'predicted' | 'pending' | 'vat'
  const [perfSection, setPerfSection] = useState(financeViewMemory.perfSection); // Performance toggle: 'income' | 'sales' | 'salesvspp'
  const [mode, setMode] = useState(financeViewMemory.mode); // 'month' | 'quarter' | 'year'
  const [year, setYear] = useState(() => financeViewMemory.year ?? now.getFullYear());
  const [quarterKey, setQuarterKey] = useState(() => financeViewMemory.quarterKey ?? recentQuarters(1)[0]); // 'YYYY-Qn'
  const [monthKey, setMonthKey] = useState(() => financeViewMemory.monthKey ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`); // 'YYYY-MM'
  const [loading, setLoading] = useState(true);

  // Persist the view state so a round-trip into a deal (and Back) lands here again.
  useEffect(() => {
    Object.assign(financeViewMemory, { section, perfSection, mode, year, quarterKey, monthKey });
  }, [section, perfSection, mode, year, quarterKey, monthKey]);

  // Restore scroll on mount (re-asserting a few times as async content settles),
  // and save it on unmount — the moment just before navigating into a deal. Any
  // real user input cancels the restore so we never fight their scrolling.
  useEffect(() => {
    const target = financeViewMemory.scrollY;
    let timers = target > 0 ? [0, 60, 160, 320, 600].map((d) => setTimeout(() => window.scrollTo(0, target), d)) : [];
    const cancel = () => { timers.forEach(clearTimeout); timers = []; };
    window.addEventListener('wheel', cancel, { passive: true, once: true });
    window.addEventListener('touchstart', cancel, { passive: true, once: true });
    window.addEventListener('keydown', cancel, { once: true });
    return () => {
      cancel();
      window.removeEventListener('wheel', cancel);
      window.removeEventListener('touchstart', cancel);
      window.removeEventListener('keydown', cancel);
      financeViewMemory.scrollY = window.scrollY;
    };
  }, []);

  // Which year's data we need (a chosen quarter / month dictates its own year).
  const qYear = Number(quarterKey.split('-Q')[0]);
  const qIdx = Number(quarterKey.split('-Q')[1]) - 1;
  const effectiveYear = mode === 'year' ? year : (mode === 'month' ? Number(monthKey.slice(0, 4)) : qYear);

  // The selected period as the income endpoint expects it: 'YYYY' / 'YYYY-Qn' / 'YYYY-MM'.
  const periodParam = mode === 'year' ? String(year) : (mode === 'quarter' ? quarterKey : monthKey);

  useEffect(() => {
    let active = true;
    setLoading(true);
    actions.loadFinanceStats(effectiveYear).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [actions, effectiveYear]);

  // Income ledger is period-scoped — reload when the selected period changes.
  useEffect(() => { actions.loadIncome(periodParam); }, [actions, periodParam]);

  // Sales breakdown (cash generated by signings + extras) is only needed when the
  // Performance toggle is on Sales — load the year's stats + the period's ledger.
  const isSales = perfSection === 'sales';
  useEffect(() => { if (isSales) actions.loadSalesFinanceStats(effectiveYear); }, [actions, isSales, effectiveYear]);
  useEffect(() => { if (isSales) actions.loadSalesLedger(periodParam); }, [actions, isSales, periodParam]);

  // Outstanding deals aren't period-scoped — load once. Same for partner credits
  // (the Partners section in Pending Payments).
  useEffect(() => { actions.loadPendingPayments(); }, [actions]);
  useEffect(() => { actions.fetchPartnerCreditsList(); }, [actions]);

  // Predicted-this-month list — always the current calendar month, independent of
  // the period picker. Passed as a key to the store so a month rollover reloads.
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const currentMonthName = now.toLocaleString('en-GB', { month: 'long' });
  useEffect(() => { actions.loadPredictedPayments(currentMonthKey); }, [actions, currentMonthKey]);

  // Rolling trend (charts) — load 36 months (the Performance comparison needs
  // the full window; the bar charts below slice the last 12). Period-independent.
  useEffect(() => { if (!state.trend) actions.loadTrend(36); }, [actions, state.trend]);
  const trend = state.trend;

  // Reload everything a paid PP touches (pending list + income ledger + net
  // revenue + trend) using the period that's currently selected.
  const refreshFinance = () => {
    actions.loadPendingPayments();
    actions.loadPredictedPayments(currentMonthKey); // refresh banked-so-far + the predicted list
    actions.loadIncome(periodParam);
    actions.loadFinanceStats(effectiveYear);
    actions.loadTrend(36);
    actions.bumpFinanceRefresh(); // nudges the Performance panel (its own period)
  };

  // Back-date (or re-date) an income-ledger payment, then refresh + make undoable.
  const setIncomeDate = (r, newDate) => {
    if (!r.editKey || !newDate) return;
    const oldDate = r.paidAt ? r.paidAt.slice(0, 10) : null;
    const apply = (date) => actions.setIncomeDate({ source: r.source, key: r.editKey, paidAt: date }).then(refreshFinance);
    apply(newDate).then(() => {
      if (!oldDate) return;
      actions.recordUndo && actions.recordUndo({
        label: `Re-date ${r.company || 'payment'}`,
        undo: () => apply(oldDate),
        redo: () => apply(newDate),
      });
    });
  };

  const fin = state.financeStats && state.financeStats.year === effectiveYear ? state.financeStats : null;
  const salesFin = state.salesFinanceStats && state.salesFinanceStats.year === effectiveYear ? state.salesFinanceStats : null;
  const salesLedger = state.salesLedger && state.salesLedger.period === periodParam ? state.salesLedger : null;
  const pending = state.pendingPayments;
  const income = state.income && state.income.period === periodParam ? state.income : null;
  // Active partners (subscription + credits-only) for the Pending Payments
  // Partners section; their outstanding £ rolls into the total outstanding.
  // A credits-only partner whose remaining credits are worth £0 owes nothing,
  // so it's neither pending nor predicted — drop those (subscriptions always
  // owe next month's fee, so they stay).
  const activePartners = (state.partnerCreditsList || [])
    .filter((p) => p.status === 'active' || p.status === 'credits_only')
    .filter((p) => (Number(p.outstanding) || 0) > 0.005);
  const partnerTotal = activePartners.reduce((s, p) => s + (Number(p.outstanding) || 0), 0);

  // Predicted-this-month flags + the shared toggle, exposed to every Pending
  // Payments row via context (so the ⋮ menu can flag/unflag without prop drilling).
  const predicted = state.predictedPayments && state.predictedPayments.month === currentMonthKey ? state.predictedPayments : null;
  const predictKeys = useMemo(() => new Set(predicted?.keys || []), [predicted]);
  const excludedKeys = useMemo(() => new Set(predicted?.excludedKeys || []), [predicted]);
  const predictCtx = useMemo(() => ({
    month: currentMonthKey,
    keys: predictKeys,
    toggle: (item, on) => actions.togglePredictedPayment(currentMonthKey, item.key, on, item.label || null, Number(item.amount) || 0),
    // Mark predicted for a chosen month (the expected pay date's month), then
    // refresh the in-view list so it reflects immediately when that's this month.
    predictInMonth: (item, month) => actions.predictPaymentInMonth(month, item.key, item.label || null, Number(item.amount) || 0)
      .then((r) => { actions.loadPredictedPayments(currentMonthKey); return r; }),
  }), [currentMonthKey, predictKeys, actions]);
  // Live total of everything still predicted to land this month — drives the
  // Predicted tab and the "with predicted" projection on the Performance chart.
  const predictedTotal = useMemo(
    () => collectPredicted(pending, activePartners, predictKeys, excludedKeys).reduce((s, it) => s + it.amount, 0),
    [pending, activePartners, predictKeys, excludedKeys],
  );
  // Live monthly income targets (Minimum / £4k / £5k) for the Predicted tab's
  // over/under-target metric — same figures the Performance pacing uses.
  useEffect(() => { actions.loadCashflowTargets(); }, [actions]);
  const incomeTargets = useMemo(
    () => resolveIncomeTargets(state.financeTargets, state.cashflowTargets),
    [state.financeTargets, state.cashflowTargets],
  );

  const isCurrentYear = effectiveYear === now.getFullYear();
  const monthIdx = now.getMonth();

  const viewArgs = { mode, qIdx, monthKey, isCurrentYear, monthIdx, effectiveYear };
  const view = useMemo(() => buildFinanceView(fin, viewArgs), [fin, mode, qIdx, monthKey, isCurrentYear, monthIdx, effectiveYear]);
  const salesView = useMemo(() => buildFinanceView(salesFin, viewArgs), [salesFin, mode, qIdx, monthKey, isCurrentYear, monthIdx, effectiveYear]);

  // The first finance tab shows Income (cash received) or, when the Performance
  // toggle is on Sales, the cash generated by signings + extras — same layout.
  const firstTab = isSales
    ? { view: salesView, label: 'Sales' }
    : { view, label: 'Income' };

  // Rolling 12-month series for the trend charts (period-independent). The first
  // tab's bar shows cash-in (Income) or cash-generated (Sales); the Sales-vs-PP's
  // tab compares cash-in against new money owed.
  const trendChart = useMemo(() => (trend?.months || []).slice(-12).map((m) => ({
    label: shortMonth(m.month),
    cashIn: m.cashIn,
    cashGenerated: m.cashGenerated,
    pps: m.pps,
  })), [trend]);
  const trendBar = isSales ? 'cashGenerated' : 'cashIn';

  const yearOptions = [now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2];

  return (
    <PredictContext.Provider value={predictCtx}>
    <div style={{ padding: isMobile ? '20px 16px' : '40px 24px', maxWidth: 1100, margin: '0 auto' }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <PoundSterling size={22} color={BRAND.blue} />
              <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Finance</h1>
            </div>
          </div>
        </div>
      </header>

      {/* Performance — cash pacing vs targets — sits above the finance tabs. Its
          Income/Sales toggle is lifted here so it also drives the first tab. */}
      <PerformancePanel section={perfSection} onSection={setPerfSection} predictedTotal={predictedTotal} predictedMonthKey={currentMonthKey} />

      {/* Section tabs — Income (or Sales) / Pending Payments / VAT. The period
          picker lives here, next to the figures it drives, so changing it shows
          a visible change. Pending Payments is all-time, so it's hidden there. */}
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <Segmented
          value={section}
          onChange={setSection}
          options={[{ value: 'income', label: firstTab.label }, { value: 'predicted', label: `Predicted ${currentMonthName} Payments` }, { value: 'pending', label: 'Pending Payments' }, { value: 'vat', label: 'VAT & Corp tax' }]}
        />
        {section !== 'pending' && section !== 'predicted' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Segmented
              value={mode}
              onChange={setMode}
              options={[{ value: 'month', label: 'Month' }, { value: 'quarter', label: 'Quarter' }, { value: 'year', label: 'Year' }]}
            />
            <select
              value={mode === 'year' ? year : mode === 'quarter' ? quarterKey : monthKey}
              onChange={(e) => (mode === 'year' ? setYear(Number(e.target.value)) : mode === 'quarter' ? setQuarterKey(e.target.value) : setMonthKey(e.target.value))}
              style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid ' + BRAND.border, background: 'white', fontSize: 14, color: BRAND.ink }}
            >
              {mode === 'year'
                ? yearOptions.map((y) => <option key={y} value={y}>{y}</option>)
                : mode === 'quarter'
                  ? recentQuarters(8).map((k) => { const [y, q] = k.split('-Q'); return <option key={k} value={k}>{`Q${q} ${y}`}</option>; })
                  : recentMonths(12).map((k) => <option key={k} value={k}>{monthLongLabel(k)}</option>)}
            </select>
          </div>
        )}
      </div>

      {section === 'income' && (
        <>
          {/* Headline for the period — net is the lead figure. Income = cash
              received; Sales = cash generated by signings + extras. */}
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, 1fr)', gap: 12, marginBottom: 16 }}>
            <StatCard icon={Wallet} accent={BRAND.blue}
              label={`${isSales ? 'Cash generated (ex-VAT)' : 'Net revenue (ex-VAT)'} — ${firstTab.view.periodLabel}`}
              value={formatGBP(firstTab.view.totals.net)}
              sub={`${formatGBP(firstTab.view.totals.gross)} gross ${isSales ? 'generated' : 'banked'}`} />
            <StatCard icon={Landmark} accent={BRAND.ink}
              label={`${isSales ? 'Gross generated' : 'Gross banked'} — ${firstTab.view.periodLabel}`}
              value={formatGBP(firstTab.view.totals.gross)}
              sub={`Net + VAT ${isSales ? 'generated' : 'received'}`} />
          </div>

          {/* Rolling 12-month bar chart (period-independent). */}
          <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 12 : 20, marginBottom: 20 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
              {isSales ? 'Cash generated (ex-VAT)' : 'Net revenue (ex-VAT)'} — last 12 months
            </h3>
            {!trend ? (
              <div style={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', color: BRAND.muted, fontSize: 14 }}>Loading…</div>
            ) : (
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={trendChart} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={BRAND.border} />
                  <XAxis dataKey="label" tick={{ fontSize: 12, fill: BRAND.muted }} />
                  <YAxis tickFormatter={gbpK} tick={{ fontSize: 12, fill: BRAND.muted }} width={56} />
                  <Tooltip formatter={(v, n) => [formatGBP(v), n]} cursor={{ fill: 'rgba(43,184,230,0.06)' }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey={trendBar} name={isSales ? 'Cash generated (ex-VAT)' : 'Net revenue (ex-VAT)'} fill={BRAND.blue} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Itemised ledger — payments received (Income) or signings + extras (Sales). */}
          {isSales ? (
            <SalesLedgerPanel ledger={salesLedger} onOpenDeal={onOpenDeal} isMobile={isMobile} periodLabel={firstTab.view.periodLabel} />
          ) : (
            <IncomePayments income={income} onOpenDeal={onOpenDeal} isMobile={isMobile} periodLabel={firstTab.view.periodLabel} onSetDate={setIncomeDate} />
          )}
        </>
      )}

      {section === 'predicted' && (
        <PredictedPaymentsSection
          pending={pending}
          partners={activePartners}
          predictKeys={predictKeys}
          excludedKeys={excludedKeys}
          monthName={currentMonthName}
          bankedNet={predicted?.bankedNet || 0}
          targets={incomeTargets}
          notes={predicted?.notes || {}}
          onSaveNote={(key, note) => actions.setPredictedPaymentNote(currentMonthKey, key, note)}
          onUnpredict={(key) => actions.togglePredictedPayment(currentMonthKey, key, false)}
          onExclude={(item, excluded) => actions.excludePredictedPayment(currentMonthKey, item.key, excluded, item.label || item.name || null, Number(item.amount) || 0)}
          onOpenDeal={onOpenDeal}
          onOpenCompany={onOpenCompany}
          onOpenPartner={onOpenPartner}
          actions={actions}
          onChanged={refreshFinance}
          isMobile={isMobile}
        />
      )}

      {section === 'vat' && (
        <>
          {/* VAT and Corporation Tax to set aside, both for the selected period. */}
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, 1fr)', gap: 12, marginBottom: 16 }}>
            <StatCard icon={PiggyBank} accent={VAT_COLOR} label={`VAT to set aside — ${view.periodLabel}`} value={formatGBP(view.totals.vat)} sub={`From cash banked in ${view.periodLabel}`} />
            <StatCard icon={Landmark} accent={CT_COLOR} label={`Corp Tax to set aside — ${view.periodLabel}`} value={formatGBP(view.totals.corpTax || 0)} sub={`Estimated on ${view.periodLabel} profit (HMRC marginal relief)`} />
          </div>

          {mode === 'year' && (
            <div style={{ marginBottom: 16 }}>
              <QuarterMenuCard
                quarters={view.quarters}
                currentIdx={isCurrentYear ? Math.floor(monthIdx / 3) : -1}
                label={isCurrentYear && view.thisQuarter ? `Jump to a quarter — ${view.thisQuarter.label}` : `Jump to a quarter — ${effectiveYear}`}
                value={formatGBP(isCurrentYear && view.thisQuarter ? view.thisQuarter.vat : view.totals.vat)}
                onPick={(i) => { setQuarterKey(`${effectiveYear}-Q${i + 1}`); setMode('quarter'); }}
              />
            </div>
          )}

          {/* Monthly breakdown table. */}
          <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 12 : 20 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
              Monthly breakdown — {view.periodLabel}
            </h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: 'right', color: BRAND.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    <th style={{ textAlign: 'left', padding: '8px 8px' }}>Month</th>
                    <th style={{ padding: '8px 8px' }}>Net (ex-VAT)</th>
                    <th style={{ padding: '8px 8px', color: VAT_COLOR }}>VAT to save</th>
                    <th style={{ padding: '8px 8px', color: CT_COLOR }}>Corp Tax to save</th>
                    <th style={{ padding: '8px 8px' }}>Gross</th>
                  </tr>
                </thead>
                <tbody>
                  {view.displayMonths.map((m) => {
                    const isThis = isCurrentYear && m.month === `${effectiveYear}-${String(monthIdx + 1).padStart(2, '0')}`;
                    return (
                      <tr key={m.month} style={{ borderTop: '1px solid ' + BRAND.border, background: isThis ? '#F4FBFE' : 'transparent' }}>
                        <td style={{ textAlign: 'left', padding: '8px 8px', fontWeight: isThis ? 700 : 500 }}>
                          {shortMonth(m.month)}{isThis ? ' · this month' : ''}
                        </td>
                        <td style={{ textAlign: 'right', padding: '8px 8px' }}>{formatGBP(m.net)}</td>
                        <td style={{ textAlign: 'right', padding: '8px 8px', fontWeight: 600, color: m.vat > 0 ? VAT_COLOR : BRAND.muted }}>{formatGBP(m.vat)}</td>
                        <td style={{ textAlign: 'right', padding: '8px 8px', fontWeight: 600, color: (m.corpTax || 0) > 0 ? CT_COLOR : BRAND.muted }}>{formatGBP(m.corpTax || 0)}</td>
                        <td style={{ textAlign: 'right', padding: '8px 8px', color: BRAND.muted }}>{formatGBP(m.gross)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                {mode !== 'month' && (
                  <tfoot>
                    <tr style={{ borderTop: '2px solid ' + BRAND.border, fontWeight: 700 }}>
                      <td style={{ textAlign: 'left', padding: '10px 8px' }}>Total {view.periodLabel}</td>
                      <td style={{ textAlign: 'right', padding: '10px 8px' }}>{formatGBP(view.totals.net)}</td>
                      <td style={{ textAlign: 'right', padding: '10px 8px', color: VAT_COLOR }}>{formatGBP(view.totals.vat)}</td>
                      <td style={{ textAlign: 'right', padding: '10px 8px', color: CT_COLOR }}>{formatGBP(view.totals.corpTax || 0)}</td>
                      <td style={{ textAlign: 'right', padding: '10px 8px' }}>{formatGBP(view.totals.gross)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </>
      )}

      {section === 'pending' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
            <StatCard icon={PoundSterling} accent={BRAND.ink} label="Total Invoiced" value={formatGBP(pending?.totals?.invoiced || 0)} sub="Invoiced & awaiting — CRM + imports · ex-VAT (net)" />
            <StatCard icon={PoundSterling} accent="#0E7490" label="Not yet invoiced" value={formatGBP(pending?.totals?.notInvoiced || 0)} sub="Everything still to bill — signed work + imports · ex-VAT (net)" />
            <StatCard icon={PoundSterling} accent={BRAND.blue} label="Total pending payments" value={formatGBP((pending?.totals?.invoiced || 0) + (pending?.totals?.notInvoiced || 0) + partnerTotal + (pending?.totals?.other || 0))} sub="Invoiced + not yet invoiced + partners + other — all outstanding · ex-VAT (net)" />
          </div>
          {/* Pending Payments — outstanding signed deals, split PO vs normal, plus
              the imported Live Sales Sheet group and active partners. */}
          <PendingPayments pending={pending} partners={activePartners} partnerTotal={partnerTotal} onOpenDeal={onOpenDeal} onOpenCompany={onOpenCompany} onOpenPartner={onOpenPartner} companies={companyOptions} isMobile={isMobile} actions={actions} onChanged={refreshFinance} />
        </>
      )}
    </div>
    </PredictContext.Provider>
  );
}

// Payment-type labels mirroring the sales sheet's "Invoice Type" column. A
// 50/50 deal shows a deposit + final line; "full" / PO deals show one line.
const PAYMENT_TYPE_META = {
  deposit: { label: '50% Deposit', color: '#B45309', bg: '#FFFBEB' },
  final: { label: '50% Final', color: '#1D4ED8', bg: '#EFF6FF' },
  full: { label: 'Full up front', color: '#15803D', bg: '#ECFDF3' },
  po: { label: 'Purchase order', color: '#6D28D9', bg: '#F5F3FF' },
  extra: { label: 'Extra', color: '#C2410C', bg: '#FFF7ED' },
  invoice: { label: 'Invoice', color: '#0E7490', bg: '#ECFEFF' },
};

// The secondary (subtitle) line for a predicted row — mirrors what each item
// shows on the Pending Payments list.
function predictedSubtitle(item) {
  const r = item.row || {};
  if (item.type === 'deal') return (r.company && r.title && r.title !== r.company) ? r.title : null;
  if (item.type === 'manual') return [r.invoiceType, r.poNumber, r.description, r.note].filter(Boolean).join(' · ') || null;
  if (item.type === 'partner') {
    const credits = Number(r.creditsRemaining) || 0;
    return (r.status === 'credits_only' && credits > 0) ? `${credits % 1 === 0 ? credits : credits.toFixed(1)} credits left` : null;
  }
  if (item.type === 'other') return r.note || null;
  return null;
}

// The same badges an item carries on the Pending Payments list: proposal number
// + payment-type + PO pill + invoiced tags for deals; imported/linked badge for
// manual rows; subscription/credits badge for partners.
function PredictedRowBadges({ item }) {
  const r = item.row || {};
  if (item.type === 'deal') {
    const number = r.number ? formatProposalNumber(r.number) : '';
    const lines = (r.lines && r.lines.length) ? r.lines : [];
    const types = [...new Set(lines.map((l) => l.type))];
    const anyNotInvoiced = lines.some((l) => l.invoiced === false);
    return (
      <>
        {number && <span style={{ fontSize: 11, fontWeight: 600, color: BRAND.muted, flexShrink: 0 }}>{number}</span>}
        {item.isPo && <PoStatusPill d={r} />}
        {types.map((t) => <PaymentBadge key={t} type={t} />)}
        {anyNotInvoiced && <NotInvoicedTag />}
      </>
    );
  }
  if (item.type === 'manual') {
    if (r.kind === 'company-invoice') {
      return <span style={{ fontSize: 9, fontWeight: 700, color: '#B45309', background: '#FFFBEB', padding: '1px 5px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>Not linked to a deal</span>;
    }
    if (r.companyId || r.dealId) {
      return <span style={{ fontSize: 9, fontWeight: 700, color: '#15803D', background: '#ECFDF3', padding: '1px 5px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>{r.companyId ? 'Customer' : 'Linked'}</span>;
    }
    return <span style={{ fontSize: 9, fontWeight: 700, color: '#0E7490', background: '#ECFEFF', padding: '1px 5px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>Imported</span>;
  }
  if (item.type === 'partner') {
    const meta = PARTNER_STATUS_META[r.status] || PARTNER_STATUS_META.active;
    return <span style={{ fontSize: 9, fontWeight: 700, color: meta.color, background: meta.bg, padding: '1px 5px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>{meta.label}</span>;
  }
  if (item.type === 'other') {
    return <span style={{ fontSize: 9, fontWeight: 700, color: OTHER_ACCENT, background: '#FFF7ED', padding: '1px 5px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>Recurring</span>;
  }
  return null;
}

// The "Predicted <month> Payments" tab. Derives its list live by intersecting the
// flagged item keys (state.predictedPayments.keys) with the current pending rows +
// active partners — so a predicted item that's since been paid simply drops off
// (and is already counted in the banked figure). Projects the month-end position
// as banked-so-far + everything still predicted to land. All figures ex-VAT (net).
function PredictedPaymentsSection({ pending, partners, predictKeys, excludedKeys, monthName, bankedNet, targets, notes = {}, onSaveNote, onUnpredict, onExclude, onOpenDeal, onOpenCompany, onOpenPartner, actions, onChanged, isMobile }) {
  const [editOther, setEditOther] = useState(null); // the "Other" row being edited
  const [noteTarget, setNoteTarget] = useState(null); // { key, name, note } being edited
  const items = useMemo(() => collectPredicted(pending, partners, predictKeys, excludedKeys).map((it) => ({
    ...it,
    open: it.dealId && onOpenDeal ? () => onOpenDeal(it.dealId)
      : it.companyId && onOpenCompany ? () => onOpenCompany(it.companyId)
        : it.clientKey && onOpenPartner ? () => onOpenPartner(it.clientKey) : null,
  })), [pending, partners, predictKeys, excludedKeys, onOpenDeal, onOpenCompany, onOpenPartner]);

  // Auto items (partners / other recurring) switched OFF for this month — shown
  // muted at the bottom so they're easy to add back. Recomputed from the live
  // data with exclusions ignored, then filtered to the excluded auto keys.
  const excludedItems = useMemo(() => {
    if (!excludedKeys || excludedKeys.size === 0) return [];
    return collectPredicted(pending, partners, predictKeys, new Set())
      .filter((it) => it.auto && excludedKeys.has(it.key));
  }, [pending, partners, predictKeys, excludedKeys]);

  // Bank a predicted payment without leaving the tab. Imported PP/PO rows mark
  // paid via the pending-payment toggle (Stripe/BACS); active partners record
  // this month's fee. Signed deals go through their own invoice flow, so there
  // they stay "Open deal" only. After any change, refresh the finance figures.
  const markPaid = (it, method) => {
    if (!actions) return;
    let p = null;
    if (it.type === 'manual') p = actions.markPendingPaymentPaid(it.row.id, true, method);
    else if (it.type === 'partner') p = actions.markPartnerFeePaid(it.clientKey, true);
    else if (it.type === 'deal' && it.row?.proposalId) {
      // Signed deals record a real payment against the proposal (advances to paid
      // + enters production). Confirm the gross amount first — it's heavier than a
      // sheet row, and the list shows net.
      const gross = Number(it.row.outstandingGross) || 0;
      const net = Number(it.amount) || 0;
      const ok = window.confirm(`Record a ${method === 'bacs' ? 'BACS' : 'Stripe'} payment of ${formatGBP(gross)} (inc VAT · ${formatGBP(net)} net) for "${it.name}"?\n\nThis marks the deal paid and moves it into production.`);
      if (!ok) return;
      p = actions.recordDealPayment(it.row.proposalId, gross, method);
    }
    if (p) Promise.resolve(p).then(() => onChanged && onChanged());
  };

  // Remove an "Other" recurring item outright (it also drops off Pending Payments).
  const removeOther = (row) => {
    if (!actions || !row) return;
    if (window.confirm(`Remove "${row.label || 'this item'}" from Other recurring revenue?\n\nIt drops off the outstanding total and stops being predicted.`)) {
      Promise.resolve(actions.deleteRecurringOther(row.id, row)).then(() => onChanged && onChanged());
    }
  };

  const predictedTotal = items.reduce((s, it) => s + it.amount, 0);
  const projected = (Number(bankedNet) || 0) + predictedTotal;

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
        <StatCard icon={Wallet} accent={BRAND.blue} label={`Banked so far — ${monthName}`} value={formatGBP(bankedNet || 0)} sub="Cash already received this month · ex-VAT (net)" />
        <StatCard icon={CalendarCheck} accent={PREDICT_COLOR} label="Predicted still to come" value={formatGBP(predictedTotal)} sub={`${items.length} ${items.length === 1 ? 'payment' : 'payments'} predicted this month (partners & other auto-included) · ex-VAT (net)`} />
        <StatCard icon={TrendingUp} accent={BRAND.ink} label={`Projected ${monthName} month-end`} value={formatGBP(projected)} sub="Banked + everything predicted, if all predicted payers pay · ex-VAT (net)" />
      </div>

      {/* If all predicted land — the projected month-end vs each monthly income
          target: "+£X over" (green) or "−£X under" (red). */}
      {(targets || []).length > 0 && (
        <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderLeft: `3px solid ${PREDICT_COLOR}`, borderRadius: 10, padding: isMobile ? 14 : '14px 18px', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>If all predicted land</span>
            <span style={{ fontSize: 12, color: BRAND.muted }}>
              projected month-end <strong style={{ color: PREDICT_COLOR }}>{formatGBP(projected)}</strong> · +{formatGBP(predictedTotal)} predicted
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : `repeat(${targets.length}, 1fr)`, gap: 10 }}>
            {targets.map((t) => {
              const target = Number(t.amount) || 0;
              const delta = projected - target;
              const over = delta >= 0;
              return (
                <div key={t.key} style={{ border: '1px solid ' + BRAND.border, borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4, minWidth: 0 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: t.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.label}</span>
                    <span style={{ fontSize: 11, color: BRAND.muted, flexShrink: 0 }}>{formatGBP(target)}</span>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: over ? '#10B981' : '#EF4444' }}>
                    {(over ? '+' : '−') + formatGBP(Math.abs(delta))}
                  </div>
                  <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>{over ? 'over target' : 'under target'} with predicted</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 12 : 20, marginTop: 4 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          Predicted {monthName} Payments
        </h3>
        <p style={{ margin: '0 0 16px', fontSize: 12, color: BRAND.muted }}>
          Pending payments you expect to land this month. Flag any row from Pending Payments using its <strong>⋮</strong> menu → <strong>Predict this month</strong>. When one lands, use a row's <strong>⋮</strong> menu here to <strong>mark it paid</strong> (it then banks and drops off automatically). Shown ex-VAT (net).
        </p>
        {!pending ? (
          <div style={{ padding: '12px 4px', fontSize: 13, color: BRAND.muted }}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{ padding: '14px 4px', fontSize: 13, color: BRAND.muted, fontStyle: 'italic' }}>
            Nothing predicted yet — open the <strong>Pending Payments</strong> tab and use a row's ⋮ menu to mark it “Predict this month”.
          </div>
        ) : (
          <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
            {items.map((it) => {
              const clickable = !!it.open;
              const subtitle = predictedSubtitle(it);
              const perMo = it.type === 'partner' && it.row?.status === 'active';
              const note = notes[it.key] || '';
              return (
                <div
                  key={it.key}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? it.open : undefined}
                  onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); it.open(); } } : undefined}
                  onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.paper; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'white'; }}
                  style={{ padding: '9px 14px', borderTop: '1px solid ' + BRAND.border, background: 'white', cursor: clickable ? 'pointer' : 'default' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: clickable ? BRAND.blue : BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{it.name}</span>
                        <PredictedRowBadges item={it} />
                      </div>
                      {subtitle && (
                        <div title={subtitle} style={{ fontSize: 11, color: BRAND.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>{subtitle}</div>
                      )}
                    </div>
                    <span style={{ fontSize: 9, fontWeight: 700, color: BRAND.muted, background: BRAND.paper, padding: '1px 6px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>{it.source}</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink, flexShrink: 0, minWidth: 70, textAlign: 'right' }}>{formatGBP(it.amount)}{perMo ? '/mo' : ''}</span>
                    <RowActionsMenu items={[
                      it.type === 'manual' && { label: 'Mark paid — Stripe', icon: CreditCard, onClick: () => markPaid(it, 'stripe') },
                      it.type === 'manual' && { label: 'Mark paid — BACS', icon: Banknote, onClick: () => markPaid(it, 'bacs') },
                      it.type === 'deal' && it.row?.proposalId && { label: 'Mark paid — Stripe', icon: CreditCard, onClick: () => markPaid(it, 'stripe') },
                      it.type === 'deal' && it.row?.proposalId && { label: 'Mark paid — BACS', icon: Banknote, onClick: () => markPaid(it, 'bacs') },
                      it.type === 'partner' && { label: 'Mark paid this month', icon: Check, onClick: () => markPaid(it) },
                      it.type === 'other' && { label: 'Edit', icon: Pencil, onClick: () => setEditOther(it.row) },
                      { label: note ? 'Edit note' : 'Add note', icon: StickyNote, onClick: () => setNoteTarget({ key: it.key, name: it.name, note }) },
                      it.type === 'other' && { label: 'Remove', icon: Trash2, onClick: () => removeOther(it.row) },
                      it.open && { label: it.dealId ? 'Open deal' : it.companyId ? 'Open customer' : 'Open partner', icon: ExternalLink, onClick: it.open },
                      // Manual rows un-flag; auto rows (partners / other) get
                      // excluded for this month and listed below to add back.
                      it.auto
                        ? (onExclude && { label: 'Remove from predicted', icon: X, onClick: () => onExclude(it, true) })
                        : { label: 'Remove from predicted', icon: X, onClick: () => onUnpredict(it.key) },
                    ]} />
                  </div>
                  {note && (
                    <div
                      onClick={(e) => { e.stopPropagation(); setNoteTarget({ key: it.key, name: it.name, note }); }}
                      title="Edit note"
                      style={{ display: 'flex', gap: 6, marginTop: 7, padding: '6px 8px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 6, cursor: 'pointer' }}
                    >
                      <StickyNote size={13} color="#B45309" style={{ flexShrink: 0, marginTop: 1 }} />
                      <span style={{ fontSize: 12, color: '#92400E', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{note}</span>
                    </div>
                  )}
                </div>
              );
            })}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '10px 14px', borderTop: '2px solid ' + BRAND.border, fontSize: 13, fontWeight: 700, color: BRAND.ink }}>
              <span>Total predicted</span>
              <span>{formatGBP(predictedTotal)}</span>
            </div>
          </div>
        )}

        {excludedItems.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              Excluded this month · not counted
            </div>
            <div style={{ border: '1px dashed ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
              {excludedItems.map((it) => (
                <div key={it.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderTop: '1px solid ' + BRAND.border, background: BRAND.paper }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: BRAND.muted, textDecoration: 'line-through', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</span>
                  <span style={{ fontSize: 9, fontWeight: 700, color: BRAND.muted, background: 'white', padding: '1px 6px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>{it.source}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.muted, flexShrink: 0, minWidth: 70, textAlign: 'right', textDecoration: 'line-through' }}>{formatGBP(it.amount)}</span>
                  <button
                    type="button"
                    onClick={() => onExclude && onExclude(it, false)}
                    className="btn-ghost"
                    style={{ padding: '3px 10px', fontSize: 12, flexShrink: 0 }}
                  >Add back</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {editOther && (
        <EditOtherModal
          row={editOther}
          actions={actions}
          isMobile={isMobile}
          onClose={() => setEditOther(null)}
          onSaved={() => { setEditOther(null); onChanged && onChanged(); }}
        />
      )}
      {noteTarget && (
        <PredictedNoteModal
          target={noteTarget}
          onClose={() => setNoteTarget(null)}
          onSave={(text) => { onSaveNote && onSaveNote(noteTarget.key, text); setNoteTarget(null); }}
        />
      )}
    </>
  );
}

// Small modal to add / edit / clear a predicted-payment progress note (used at
// the regular catch-up meetings about how each deal/project is progressing).
function PredictedNoteModal({ target, onClose, onSave }) {
  const [text, setText] = useState(target.note || '');
  const editing = !!target.note;
  return (
    <Modal onClose={onClose} maxWidth={460} showClose={false}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{editing ? 'Edit note' : 'Add note'}</h2>
        <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
      </div>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: BRAND.muted }}>
        {target.name} — note how the deal / project is progressing. Shown on the predicted list for your catch-up meetings.
      </p>
      <textarea
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder="e.g. Awaiting sign-off on V2; client said payment due end of month."
        style={{ width: '100%', boxSizing: 'border-box', padding: 10, borderRadius: 8, border: '1px solid ' + BRAND.border, fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 16 }}>
        {editing
          ? <button onClick={() => onSave('')} className="btn-ghost" style={{ color: '#B91C1C' }}><Trash2 size={14} /> Remove note</button>
          : <span />}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <button onClick={() => onSave(text)} className="btn-primary">Save note</button>
        </div>
      </div>
    </Modal>
  );
}

function PendingPayments({ pending, partners, partnerTotal, onOpenDeal, onOpenCompany, onOpenPartner, companies, isMobile, actions, onChanged }) {
  // The deal + portion to invoice when an INV button is clicked (opens the
  // shared Xero create-invoice modal, pre-filled with the deal's suggested lines).
  const [invTarget, setInvTarget] = useState(null);
  // The PO-route deal whose PO number we're recording (opens MarkPoReceivedModal).
  const [poTarget, setPoTarget] = useState(null);
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 12 : 20, marginTop: 20 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
        Pending Payments
      </h3>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: BRAND.muted }}>
        Invoiced and outstanding amounts awaiting payment — shown ex-VAT (net). Each signed-deal line is tagged "Not invoiced" until raised; use the ⋮ menu on a row to invoice, mark paid or open the deal.
      </p>
      {!pending ? (
        <div style={{ padding: '12px 4px', fontSize: 13, color: BRAND.muted }}>Loading…</div>
      ) : (() => {
        const manual = pending.manual || [];
        // Imported rows you've marked invoiced sit on the invoiced/awaiting list;
        // the rest stay in the not-yet-invoiced "Imported" groups.
        // The single Invoiced list = imported items you've invoiced + company
        // invoices not tied to a deal (tagged "not linked to a deal").
        const invoicedManual = [...manual.filter((r) => r.status === 'invoiced'), ...(pending.companyInvoices || [])];
        const pendingManual = manual.filter((r) => r.status !== 'invoiced');
        const pps = pendingManual.filter((r) => r.kind !== 'po');
        const pos = pendingManual.filter((r) => r.kind === 'po');
        const sumNet = (arr) => arr.reduce((s, r) => s + (Number(r.amountExVat) || 0), 0);
        // Signed deals split by invoice status: invoiced portions join the
        // Invoiced panel, not-yet-invoiced portions stay in Signed deals.
        const { notInvoiced: signedOutstanding, invoiced: signedInvoiced } = splitSignedByInvoiced(pending.normal);
        const sumOut = (arr) => round2Money(arr.reduce((s, d) => s + (Number(d.outstanding) || 0), 0));
        return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <InvoicedAwaitingPanel
            dealRows={signedInvoiced}
            manualRows={invoicedManual}
            actions={actions}
            onChanged={onChanged}
            onOpenDeal={onOpenDeal}
            onOpenCompany={onOpenCompany}
            companies={companies}
            isMobile={isMobile}
          />
          <PurchaseOrdersPanel
            crmRows={pending.po || []}
            crmTotal={pending.totals.po}
            importedRows={pos}
            actions={actions}
            onChanged={onChanged}
            onOpenDeal={onOpenDeal}
            onOpenCompany={onOpenCompany}
            onCreateInvoice={setInvTarget}
            onMarkPoReceived={setPoTarget}
            companies={companies}
            isMobile={isMobile}
          />
          <SignedDealsPanel
            rows={signedOutstanding}
            total={sumOut(signedOutstanding)}
            onOpenDeal={onOpenDeal}
            onCreateInvoice={setInvTarget}
            isMobile={isMobile}
          />
          {pps.length > 0 && (
            <ManualPendingGroup
              title="Imported PP's - Live Sales Sheet"
              note="Outstanding PP's from your sheet"
              kind="pp"
              rows={pps}
              total={sumNet(pps)}
              actions={actions}
              onChanged={onChanged}
              onOpenDeal={onOpenDeal}
              onOpenCompany={onOpenCompany}
              companies={companies}
              isMobile={isMobile}
            />
          )}
          <PartnersPanel partners={partners} total={partnerTotal} onOpenPartner={onOpenPartner} isMobile={isMobile} />
          <OtherPanel rows={pending.other || []} total={pending.totals?.other || 0} actions={actions} onChanged={onChanged} isMobile={isMobile} />
        </div>
        );
      })()}
      {invTarget && (
        <CreateXeroInvoiceModal
          companyId={invTarget.companyId || undefined}
          dealId={invTarget.companyId ? undefined : invTarget.dealId}
          deals={invTarget.companyId ? [{ id: invTarget.dealId, title: invTarget.title, stage: invTarget.stage || 'signed', company_id: invTarget.companyId }] : undefined}
          initialDealId={invTarget.dealId}
          initialReference={invTarget.reference || undefined}
          mode={invTarget.mode}
          onClose={() => setInvTarget(null)}
          onCreated={() => { setInvTarget(null); onChanged && onChanged(); }}
        />
      )}
      {poTarget && (
        <MarkPoReceivedModal
          target={poTarget}
          actions={actions}
          onClose={() => setPoTarget(null)}
          onSaved={() => { setPoTarget(null); onChanged && onChanged(); }}
        />
      )}
    </div>
  );
}

// Small modal to record (or edit) a PO-route deal's received PO number. The
// number is required; on save it records the PO and refreshes the pending list.
function MarkPoReceivedModal({ target, actions, onClose, onSaved }) {
  const [poNumber, setPoNumber] = useState(target.poNumber || '');
  const [saving, setSaving] = useState(false);
  const { showMsg } = useStore();
  const editing = !!target.poNumber;
  const save = async () => {
    const num = poNumber.trim();
    if (!num) return;
    setSaving(true);
    try {
      await actions.markDealPoReceived(target.dealId, num);
      showMsg?.(editing ? 'PO number updated' : 'PO marked received', 'success');
      onSaved();
    } catch (err) {
      showMsg?.(err.message || 'Could not save the PO number', 'error');
      setSaving(false);
    }
  };
  return (
    <Modal onClose={onClose} maxWidth={420} showClose={false}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{editing ? 'Edit PO number' : 'Mark PO received'}</h2>
        <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
      </div>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: BRAND.muted }}>
        {target.title || target.company || 'This deal'} — enter the purchase order number. It becomes the reference on the invoice you raise for this organisation.
      </p>
      <input
        type="text"
        value={poNumber}
        autoFocus
        onChange={(e) => setPoNumber(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
        className="input"
        placeholder="PO number (e.g. 4500012345)"
        style={{ width: '100%', boxSizing: 'border-box' }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button onClick={onClose} className="btn-ghost" disabled={saving}>Cancel</button>
        <button onClick={save} className="btn-primary" disabled={saving || !poNumber.trim()}>
          {saving ? 'Saving…' : (editing ? 'Save' : 'Mark received')}
        </button>
      </div>
    </Modal>
  );
}

const round2Money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Split each signed deal's lines by invoice status: not-yet-invoiced portions
// (→ "Signed deals — outstanding") vs invoiced-and-awaiting portions (→ the
// "Invoiced — awaiting payment" panel). A deal with a mix shows in both, but
// every individual line appears in exactly one panel — never double-counted.
function splitSignedByInvoiced(deals) {
  const notInvoiced = [];
  const invoiced = [];
  for (const d of (deals || [])) {
    const lines = (d.lines && d.lines.length) ? d.lines : [{ type: 'full', amount: d.outstanding, invoiced: false }];
    const notInv = lines.filter((l) => l.invoiced === false);
    const inv = lines.filter((l) => l.invoiced === true);
    const sum = (arr) => round2Money(arr.reduce((s, l) => s + (Number(l.amount) || 0), 0));
    if (notInv.length) notInvoiced.push({ ...d, lines: notInv, outstanding: sum(notInv) });
    if (inv.length) invoiced.push({ ...d, lines: inv, outstanding: sum(inv) });
  }
  return { notInvoiced, invoiced };
}

// Signed deals (non-PO) with a NOT-yet-invoiced balance — each line tagged, with
// an INV action on the not-yet-invoiced portions (the invoiced portions move to
// the Invoiced — awaiting payment panel).
function SignedDealsPanel({ rows, total, onOpenDeal, onCreateInvoice, isMobile }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border, borderLeft: `3px solid ${BRAND.blue}` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink }}>Signed deals — outstanding</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: BRAND.ink }}>{formatGBP(total)}</span>
        </div>
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>Signed work still to invoice · {rows.length} {rows.length === 1 ? 'deal' : 'deals'} · use the ⋮ menu to raise an invoice (invoiced portions move to “Invoiced — awaiting payment”)</div>
      </div>
      {rows.map((d) => (
        <PendingRow key={d.dealId} d={d} onOpenDeal={onOpenDeal} onCreateInvoice={onCreateInvoice} isMobile={isMobile} />
      ))}
    </div>
  );
}

// "Invoiced — awaiting payment" — one panel combining the invoiced-and-awaiting
// portions of signed CRM deals (click through to the deal; they auto-clear when
// the Xero invoice is paid) with the imported invoiced rows + company invoices
// (mark paid via their ⋮ menu). Mirrors the PurchaseOrdersPanel composition.
function InvoicedAwaitingPanel({ dealRows, manualRows, actions, onChanged, onOpenDeal, onOpenCompany, companies, isMobile }) {
  const deals = dealRows || [];
  const manual = manualRows || [];
  const dealNet = deals.reduce((s, d) => s + (Number(d.outstanding) || 0), 0);
  const manualNet = manual.reduce((s, r) => s + (Number(r.amountExVat) || 0), 0);
  const grand = round2Money(dealNet + manualNet);
  const count = deals.length + manual.length;
  if (count === 0) return null;
  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border, borderLeft: `3px solid ${BRAND.blue}` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink }}>Invoiced — awaiting payment</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: BRAND.ink }}>{formatGBP(grand)}</span>
        </div>
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>Invoiced items awaiting payment · {count} {count === 1 ? 'item' : 'items'} · signed-deal invoices auto-clear when paid in Xero; use the ⋮ menu on imported rows to mark paid</div>
      </div>
      {deals.map((d) => (
        <PendingRow key={d.dealId} d={d} onOpenDeal={onOpenDeal} isMobile={isMobile} />
      ))}
      {manual.length > 0 && (
        <ManualPendingGroup
          bare
          kind="pp"
          variant="invoiced"
          accent={BRAND.blue}
          rows={manual}
          total={manualNet}
          actions={actions}
          onChanged={onChanged}
          onOpenDeal={onOpenDeal}
          onOpenCompany={onOpenCompany}
          companies={companies}
          isMobile={isMobile}
        />
      )}
    </div>
  );
}

// Active partners (subscription + credits-only) from the Partner Programme — each
// contributes to the total outstanding: a subscription is its next monthly fee,
// a credits-only client is the value of its remaining credits (both ex-VAT).
const PARTNER_STATUS_META = {
  active: { label: 'Subscription', color: '#15803D', bg: '#ECFDF3' },
  credits_only: { label: 'Credits only', color: '#1D4ED8', bg: '#EFF6FF' },
};
function PartnersPanel({ partners, total, onOpenPartner, isMobile }) {
  const list = partners || [];
  if (list.length === 0) return null;
  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border, borderLeft: '3px solid #6D28D9' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink }}>Partners</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: BRAND.ink }}>{formatGBP(total)}</span>
        </div>
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>Active Partner Programme · {list.length} {list.length === 1 ? 'partner' : 'partners'} · subscription = next month’s fee, credits only = remaining-credit value · ex-VAT</div>
      </div>
      {list.map((p) => {
        const meta = PARTNER_STATUS_META[p.status] || PARTNER_STATUS_META.active;
        const credits = Number(p.creditsRemaining) || 0;
        const open = () => onOpenPartner && p.clientKey && onOpenPartner(p.clientKey);
        const clickable = !!(onOpenPartner && p.clientKey);
        return (
          <div
            key={p.clientKey}
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            onClick={clickable ? open : undefined}
            onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } : undefined}
            onMouseEnter={clickable ? (e) => { e.currentTarget.style.background = BRAND.paper; } : undefined}
            onMouseLeave={clickable ? (e) => { e.currentTarget.style.background = 'transparent'; } : undefined}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderTop: '1px solid ' + BRAND.border, cursor: clickable ? 'pointer' : 'default', background: 'transparent' }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.clientName || 'Partner'}</span>
            <PredictedTag auto />
            <span style={{ fontSize: 10, fontWeight: 700, color: meta.color, background: meta.bg, padding: '1px 6px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>{meta.label}</span>
            {p.status === 'credits_only' && credits > 0 && (
              <span style={{ fontSize: 11, color: BRAND.muted, flexShrink: 0 }}>{credits % 1 === 0 ? credits : credits.toFixed(1)} left</span>
            )}
            <span style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink, flexShrink: 0, minWidth: 64, textAlign: 'right' }}>{formatGBP(p.outstanding)}{p.status === 'active' ? '/mo' : ''}</span>
          </div>
        );
      })}
    </div>
  );
}

// "Other" recurring revenue — small ongoing monthly income outside CRM deals and
// the Partner Programme (e.g. web hosting). Behaves like the Partners group: each
// row is a flat monthly net + VAT that's auto-included in Predicted (it recurs).
// Add / edit / remove inline; "Other" because it can be made up of anything.
const OTHER_ACCENT = '#C2410C';

// One editable row's form: label, optional note, net + VAT. Typing Net auto-fills
// VAT at the 20% standard rate until the user edits VAT themselves.
function OtherRowForm({ initial, onSave, onCancel, isMobile, bare = false }) {
  const [label, setLabel] = useState(initial?.label || '');
  const [note, setNote] = useState(initial?.note || '');
  const [net, setNet] = useState(initial ? String(initial.amountExVat ?? '') : '');
  const [vat, setVat] = useState(initial ? String(initial.vat ?? '') : '');
  const [vatTouched, setVatTouched] = useState(!!(initial && Number(initial.vat)));
  const [saving, setSaving] = useState(false);

  const onNet = (v) => {
    setNet(v);
    if (!vatTouched) {
      const n = parseFloat(v);
      setVat(Number.isFinite(n) ? (Math.round(n * 0.2 * 100) / 100).toString() : '');
    }
  };
  const canSave = label.trim() && parseFloat(net) >= 0 && Number.isFinite(parseFloat(net));
  const submit = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      await onSave({ label: label.trim(), note: note.trim() || null, amountExVat: parseFloat(net) || 0, vat: parseFloat(vat) || 0 });
    } finally { setSaving(false); }
  };
  const inputStyle = { padding: '7px 9px', borderRadius: 7, border: '1px solid ' + BRAND.border, fontSize: 13, color: BRAND.ink, width: '100%', boxSizing: 'border-box' };

  return (
    <div style={{ padding: bare ? 0 : '10px 14px', borderTop: bare ? undefined : '1px solid ' + BRAND.border, background: bare ? undefined : '#FFFBF7' }}>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1.4fr 1.4fr 90px 90px', gap: 8 }}>
        <input style={inputStyle} placeholder="Customer / item" value={label} autoFocus onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }} />
        <input style={inputStyle} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }} />
        <input style={{ ...inputStyle, textAlign: 'right' }} placeholder="Net £" inputMode="decimal" value={net} onChange={(e) => onNet(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }} />
        <input style={{ ...inputStyle, textAlign: 'right' }} placeholder="VAT £" inputMode="decimal" value={vat} onChange={(e) => { setVatTouched(true); setVat(e.target.value); }} onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
        <button onClick={onCancel} className="btn-ghost" disabled={saving}>Cancel</button>
        <button onClick={submit} className="btn-primary" disabled={!canSave || saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

function OtherPanel({ rows, total, actions, onChanged, isMobile }) {
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState(null);
  const list = rows || [];
  const vatTotal = list.reduce((s, r) => s + (Number(r.vat) || 0), 0);

  const save = async (vals, existing) => {
    if (!actions) return;
    if (existing) {
      const before = { label: existing.label, note: existing.note, amountExVat: existing.amountExVat, vat: existing.vat };
      await actions.updateRecurringOther(existing.id, vals, before);
    } else {
      await actions.addRecurringOther(vals);
    }
    setAdding(false); setEditId(null);
    if (onChanged) onChanged();
  };
  const remove = (r) => {
    if (!actions) return;
    if (window.confirm(`Remove "${r.label || 'this item'}" from Other recurring revenue?\n\nIt drops off the outstanding total and stops being predicted.`)) {
      actions.deleteRecurringOther(r.id, r).then(() => onChanged && onChanged());
    }
  };

  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border, borderLeft: '3px solid ' + OTHER_ACCENT }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink }}>Other</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: BRAND.ink }}>{formatGBP(total)}</span>
        </div>
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>Recurring revenue from elsewhere (e.g. web hosting) · {list.length} {list.length === 1 ? 'item' : 'items'} · recurs monthly, so auto-included in Predicted · ex-VAT</div>
      </div>
      {list.map((r) => (
        editId === r.id ? (
          <OtherRowForm key={r.id} initial={r} isMobile={isMobile} onSave={(vals) => save(vals, r)} onCancel={() => setEditId(null)} />
        ) : (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderTop: '1px solid ' + BRAND.border }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{r.label || 'Other'}</span>
                <PredictedTag auto />
              </div>
              {r.note && <div title={r.note} style={{ fontSize: 11, color: BRAND.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>{r.note}</div>}
            </div>
            <span style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink, flexShrink: 0, minWidth: 64, textAlign: 'right' }}>{formatGBP(r.amountExVat)}/mo</span>
            <RowActionsMenu items={[
              { label: 'Edit', icon: Pencil, onClick: () => { setAdding(false); setEditId(r.id); } },
              { label: 'Remove', icon: Trash2, onClick: () => remove(r) },
            ]} />
          </div>
        )
      ))}
      {adding ? (
        <OtherRowForm isMobile={isMobile} onSave={(vals) => save(vals)} onCancel={() => setAdding(false)} />
      ) : (
        <button
          onClick={() => { setEditId(null); setAdding(true); }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '9px 14px', borderTop: '1px solid ' + BRAND.border, background: 'white', border: 'none', borderTopColor: BRAND.border, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: OTHER_ACCENT }}
          onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.paper; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'white'; }}
        >
          <Plus size={14} /> Add other recurring revenue
        </button>
      )}
      {list.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12, padding: '8px 14px', borderTop: '2px solid ' + BRAND.border, fontSize: 13, fontWeight: 700, color: BRAND.ink }}>
          <span>Total</span>
          <span style={{ color: VAT_COLOR }}>VAT {formatGBP(vatTotal)}</span>
          <span style={{ minWidth: 64, textAlign: 'right' }}>{formatGBP(total)}</span>
        </div>
      )}
    </div>
  );
}

// Edit an "Other" recurring-revenue row in a modal — used from the Predicted tab
// (the Pending Payments panel edits inline instead).
function EditOtherModal({ row, actions, onClose, onSaved, isMobile }) {
  const save = async (vals) => {
    if (!actions) return;
    const before = { label: row.label, note: row.note, amountExVat: row.amountExVat, vat: row.vat };
    await actions.updateRecurringOther(row.id, vals, before);
    onSaved();
  };
  return (
    <Modal onClose={onClose} maxWidth={540} showClose={false}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Edit recurring revenue</h2>
        <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
      </div>
      <OtherRowForm initial={row} isMobile={isMobile} bare onSave={save} onCancel={onClose} />
    </Modal>
  );
}

// Imported Live Sales Sheet "PP's" — outstanding work that lives outside the
// CRM's own signed deals. Dense, spreadsheet-style rows with an always-on VAT
// column. Each can be marked paid (→ flows into Income) or removed.
// Grid: item | Net | VAT | Total | actions.
const MANUAL_PP_COLS = '1fr 92px 80px 92px 92px';
const MANUAL_PP_COLS_M = '1fr 64px 72px 76px';

function ManualPendingGroup({ title, note, kind = 'pp', variant = 'pending', accent = '#0E7490', rows, total, actions, onChanged, onOpenDeal, onOpenCompany, companies, isMobile, bare = false }) {
  const cols = isMobile ? MANUAL_PP_COLS_M : MANUAL_PP_COLS;
  const vatTotal = rows.reduce((s, r) => s + (Number(r.vat) || 0), 0);
  const grossTotal = total + vatTotal;
  const noun = kind === 'po' ? 'PO' : 'PP';
  const isInvoicedGroup = variant === 'invoiced';

  // Link (or unlink) a row to a CRM deal. Undoable. Linking to a deal clears
  // any company link server-side, so the undo restores the deal link (the most
  // recent prior state we can cheaply reinstate).
  const setLink = (r, dealId) => {
    if (!actions) return;
    const prev = r.dealId || null;
    actions.linkPendingPayment(r.id, dealId).then(() => {
      if (onChanged) onChanged();
      actions.recordUndo && actions.recordUndo({
        label: dealId ? `Link ${r.company || noun} to deal` : `Unlink ${r.company || noun}`,
        undo: () => actions.linkPendingPayment(r.id, prev).then(() => onChanged && onChanged()),
        redo: () => actions.linkPendingPayment(r.id, dealId).then(() => onChanged && onChanged()),
      });
    });
  };

  // Link (or unlink) a row to a customer (company). Undoable.
  const setCompanyLink = (r, companyId) => {
    if (!actions) return;
    const prev = r.companyId || null;
    actions.linkPendingPaymentCompany(r.id, companyId).then(() => {
      if (onChanged) onChanged();
      actions.recordUndo && actions.recordUndo({
        label: companyId ? `Link ${r.company || noun} to customer` : `Unlink ${r.company || noun}`,
        undo: () => actions.linkPendingPaymentCompany(r.id, prev).then(() => onChanged && onChanged()),
        redo: () => actions.linkPendingPaymentCompany(r.id, companyId).then(() => onChanged && onChanged()),
      });
    });
  };

  // Move a row between the not-yet-invoiced and invoiced lists. Undoable.
  const setInvoiced = (r, invoiced) => {
    if (!actions) return;
    actions.markPendingPaymentInvoiced(r.id, invoiced).then(() => {
      if (onChanged) onChanged();
      actions.recordUndo && actions.recordUndo({
        label: invoiced ? `Mark ${r.company || noun} invoiced` : `Move ${r.company || noun} back to pending`,
        undo: () => actions.markPendingPaymentInvoiced(r.id, !invoiced).then(() => onChanged && onChanged()),
        redo: () => actions.markPendingPaymentInvoiced(r.id, invoiced).then(() => onChanged && onChanged()),
      });
    });
  };

  const markPaid = (r, method) => {
    if (!actions) return;
    actions.markPendingPaymentPaid(r.id, true, method).then(() => {
      if (onChanged) onChanged();
      actions.recordUndo && actions.recordUndo({
        label: `Mark ${r.company || noun} paid (${methodLabel(method) || 'paid'})`,
        // Restore to wherever it came from — the invoiced list or pending.
        undo: () => (isInvoicedGroup
          ? actions.markPendingPaymentInvoiced(r.id, true)
          : actions.markPendingPaymentPaid(r.id, false)).then(() => onChanged && onChanged()),
        redo: () => actions.markPendingPaymentPaid(r.id, true, method).then(() => onChanged && onChanged()),
      });
    });
  };
  const remove = (r) => {
    if (!actions) return;
    if (window.confirm(`Remove "${r.company || r.description || 'this item'}" from pending payments?\n\nIt will drop off the outstanding list and lower the pending total — use this for duplicates or mistakes. It is NOT recorded as paid; to bank a payment use "Mark paid" instead.`)) {
      actions.deletePendingPayment(r.id).then(() => {
        actions.recordUndo && actions.recordUndo({
          label: `Remove ${r.company || noun}`,
          undo: () => actions.restoreRecord(r.id).then(() => onChanged && onChanged()),
          redo: () => actions.deletePendingPayment(r.id).then(() => onChanged && onChanged()),
        });
      });
    }
  };

  const body = (
    <>
      {!bare && (
        <div style={{ padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border, borderLeft: '3px solid ' + accent }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink }}>{title}</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: BRAND.ink }}>{formatGBP(total)}</span>
          </div>
          <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>{note} · {rows.length} {rows.length === 1 ? 'item' : 'items'} · use the ⋮ menu to {isInvoicedGroup ? 'mark paid or move back to pending' : 'mark invoiced, mark paid or remove'}</div>
        </div>
      )}
      {rows.length === 0 ? (
        bare ? null : <div style={{ padding: 14, fontSize: 13, color: BRAND.muted, fontStyle: 'italic' }}>{isInvoicedGroup ? 'Nothing invoiced yet.' : 'Nothing outstanding — all collected.'}</div>
      ) : (
        <>
          {/* Column header — keeps the VAT column visible at all times. */}
          <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '6px 14px', background: BRAND.paper, borderTop: bare ? '1px solid ' + BRAND.border : undefined, borderBottom: '1px solid ' + BRAND.border, fontSize: 10, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            <span>{kind === 'po' ? 'Customer / PO' : 'Customer / item'}</span>
            <span style={{ textAlign: 'right' }}>Net</span>
            <span style={{ textAlign: 'right' }}>VAT</span>
            {!isMobile && <span style={{ textAlign: 'right' }}>Total</span>}
            {!isMobile && <span />}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {rows.map((r) => (
              <ManualPendingRow
                key={r.id}
                r={r}
                cols={cols}
                isMobile={isMobile}
                variant={variant}
                actions={actions}
                onPaid={(method) => markPaid(r, method)}
                onInvoice={() => setInvoiced(r, true)}
                onUninvoice={() => setInvoiced(r, false)}
                onLink={(dealId) => setLink(r, dealId)}
                onLinkCompany={(companyId) => setCompanyLink(r, companyId)}
                companies={companies}
                onOpenDeal={onOpenDeal}
                onOpenCompany={onOpenCompany}
                onRemove={() => remove(r)}
                onChanged={onChanged}
              />
            ))}
          </div>
          {/* Net / VAT / Total footer mirroring the sheet. Hidden in bare mode —
              the combining panel shows the grand total instead. */}
          {!bare && (
            <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '8px 14px', borderTop: '2px solid ' + BRAND.border, fontSize: 13, fontWeight: 700, color: BRAND.ink }}>
              <span>Total</span>
              <span style={{ textAlign: 'right' }}>{formatGBP(total)}</span>
              <span style={{ textAlign: 'right', color: VAT_COLOR }}>{formatGBP(vatTotal)}</span>
              {!isMobile && <span style={{ textAlign: 'right' }}>{formatGBP(grossTotal)}</span>}
              {!isMobile && <span />}
            </div>
          )}
        </>
      )}
      {!isInvoicedGroup && <PendingImportPanel actions={actions} kind={kind} count={rows.length} isMobile={isMobile} />}
    </>
  );
  if (bare) return body;
  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
      {body}
    </div>
  );
}

function ManualPendingRow({ r, cols, isMobile, variant = 'pending', actions, onPaid, onInvoice, onUninvoice, onLink, onLinkCompany, companies, onOpenDeal, onOpenCompany, onRemove, onChanged }) {
  const predict = usePredict();
  const [linkOpen, setLinkOpen] = useState(false);
  const [payingInvoice, setPayingInvoice] = useState(false);
  const [predictingDate, setPredictingDate] = useState(false);
  const isInvoicedGroup = variant === 'invoiced';
  const isCompanyInvoice = r.kind === 'company-invoice';
  const linkedDeal = !!r.dealId;
  // A deal in production is a "project" — affects only wording (Deal vs Project).
  const dealNoun = r.isProject ? 'project' : 'deal';
  const linkedCompany = !!r.companyId;
  const linked = linkedDeal || linkedCompany;
  const net = Number(r.amountExVat) || 0;
  const vat = Number(r.vat) || 0;
  const subtitle = [r.invoiceType, r.poNumber, r.description, r.note].filter(Boolean).join(' · ');
  // Open whatever the row is linked to — its deal, or its customer.
  const canOpen = (linkedDeal && onOpenDeal) || (linkedCompany && onOpenCompany);
  const openLinked = () => {
    if (linkedDeal && onOpenDeal) onOpenDeal(r.dealId);
    else if (linkedCompany && onOpenCompany) onOpenCompany(r.companyId);
  };
  // Shared ⋮ menu actions. A company invoice is a real Xero/manual invoice (not
  // an imported sheet row) — it marks paid through the invoice's own flow
  // (records the payment in Xero), not the imported-payment toggle.
  const rowActions = isCompanyInvoice ? [
    { label: 'Mark paid…', icon: Check, onClick: () => setPayingInvoice(true) },
    canOpen && { label: linkedDeal ? `Open ${dealNoun}` : 'Open customer', icon: ExternalLink, onClick: openLinked },
  ] : [
    isInvoicedGroup
      ? { label: 'Move back to pending', icon: RotateCcw, onClick: onUninvoice }
      : { label: 'Mark invoiced', icon: FileText, onClick: onInvoice },
    { label: 'Mark paid — Stripe', icon: CreditCard, onClick: () => onPaid('stripe') },
    { label: 'Mark paid — BACS', icon: Banknote, onClick: () => onPaid('bacs') },
    onLink && { label: linked ? 'Edit link' : 'Link to deal / customer', icon: Link2, onClick: () => setLinkOpen(true) },
    canOpen && { label: linkedCompany ? 'Open customer' : `Open ${dealNoun}`, icon: ExternalLink, onClick: openLinked },
    { label: 'Remove', icon: Trash2, danger: true, onClick: onRemove },
  ];
  const predictKey = predictKeyForManual(r);
  const predictItemLabel = r.company || r.description || 'Pending payment';
  const predictItem = predictMenuItem(predict, { key: predictKey, label: predictItemLabel, amount: net });
  if (predictItem) rowActions.push(predictItem);
  const predictDateItem = predictDateMenuItem(predict, { key: predictKey }, () => setPredictingDate(true));
  if (predictDateItem) rowActions.push(predictDateItem);
  const isPredicted = !!predict?.keys.has(predictKey);
  return (
    <>
    <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, alignItems: 'center', borderTop: '1px solid ' + BRAND.border, background: 'white', padding: '5px 14px' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {isCompanyInvoice && !linkedDeal ? (
            <span title="A company invoice — not linked to a deal" style={{ fontSize: 9, fontWeight: 700, color: '#B45309', background: '#FFFBEB', padding: '1px 5px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>
              Not linked to a deal
            </span>
          ) : linked ? (
            <span onClick={openLinked}
              title={linkedCompany
                ? (r.linkedCompanyName ? `Linked to customer: ${r.linkedCompanyName}` : 'Linked to a customer')
                : (onOpenDeal ? `Open linked ${dealNoun}` : `Linked to a CRM ${dealNoun}`)}
              style={{ cursor: canOpen ? 'pointer' : 'default', fontSize: 9, fontWeight: 700, color: '#15803D', background: '#ECFDF3', padding: '1px 5px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>
              {linkedDeal ? (r.isProject ? 'Project' : 'Deal') : linkedCompany ? 'Customer' : 'Linked'}
            </span>
          ) : (
            <span style={{ fontSize: 9, fontWeight: 700, color: '#0E7490', background: '#ECFEFF', padding: '1px 5px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>
              Imported
            </span>
          )}
          <span onClick={openLinked} style={{ fontSize: 13, fontWeight: 600, color: canOpen ? BRAND.blue : BRAND.ink, cursor: canOpen ? 'pointer' : 'default', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {r.company || 'Unattributed'}
          </span>
          {isPredicted && <PredictedTag />}
          {linkedCompany && r.linkedCompanyName && r.linkedCompanyName !== r.company && (
            <span title={`Linked to customer: ${r.linkedCompanyName}`} style={{ fontSize: 11, color: BRAND.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1 }}>
              → {r.linkedCompanyName}
            </span>
          )}
        </div>
        {subtitle && (
          <div title={subtitle} style={{ fontSize: 11, color: BRAND.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subtitle}</div>
        )}
      </div>
      <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: BRAND.ink }}>{formatGBP(net)}</div>
      <div style={{ textAlign: 'right', fontSize: 13, color: vat > 0 ? VAT_COLOR : BRAND.muted }}>{formatGBP(vat)}</div>
      {!isMobile && <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 700, color: BRAND.ink }}>{formatGBP(net + vat)}</div>}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
        <RowActionsMenu items={rowActions} />
      </div>
    </div>
    {linkOpen && (
      <LinkPicker
        actions={actions}
        companies={companies}
        linkedDeal={linkedDeal}
        linkedCompany={linkedCompany}
        onPickDeal={(dealId) => { setLinkOpen(false); onLink(dealId); }}
        onPickCompany={(companyId) => { setLinkOpen(false); onLinkCompany && onLinkCompany(companyId); }}
        onClose={() => setLinkOpen(false)}
      />
    )}
    {payingInvoice && (
      <MarkInvoicePaidModal
        invoiceId={r.id}
        invoiceNumber={r.description || undefined}
        amount={(Number(r.amountExVat) || 0) + (Number(r.vat) || 0)}
        onClose={() => setPayingInvoice(false)}
        onMarked={() => { setPayingInvoice(false); if (onChanged) onChanged(); }}
      />
    )}
    {predictingDate && (
      <PredictDateModal
        label={predictItemLabel}
        onClose={() => setPredictingDate(false)}
        onConfirm={(month) => predict.predictInMonth({ key: predictKey, label: predictItemLabel, amount: net }, month)}
      />
    )}
    </>
  );
}

// Searchable picker to link an imported PP to either a signed CRM deal OR a
// customer (company). Renders as a full-width panel beneath the row; a toggle
// switches between the two modes. Deals load lazily on first open of that tab.
function LinkPicker({ actions, companies, linkedDeal, linkedCompany, onPickDeal, onPickCompany, onClose }) {
  const [mode, setMode] = useState('deal'); // 'deal' | 'company'
  const [deals, setDeals] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    if (mode !== 'deal' || deals !== null) return undefined;
    let active = true;
    actions.loadLinkableDeals().then((list) => { if (active) setDeals(list); });
    return () => { active = false; };
  }, [actions, mode, deals]);

  const needle = q.trim().toLowerCase();
  const filteredDeals = (deals || []).filter((d) => {
    if (!needle) return true;
    const hay = `${d.company || ''} ${d.title || ''} ${d.number ? formatProposalNumber(d.number) : ''}`.toLowerCase();
    return hay.includes(needle);
  }).slice(0, 40);
  // Customers: only suggest once they start typing — the full company list is
  // too long to dump into the dropdown. Empty query → no results.
  const filteredCompanies = needle
    ? (companies || []).filter((c) => (c.name || '').toLowerCase().includes(needle)).slice(0, 40)
    : [];

  const Tab = ({ id, label }) => (
    <button
      type="button"
      onClick={() => { setMode(id); setQ(''); }}
      style={{
        fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 7, cursor: 'pointer',
        border: '1px solid ' + (mode === id ? BRAND.blue : BRAND.border),
        background: mode === id ? '#EFF6FF' : 'white',
        color: mode === id ? BRAND.blue : BRAND.muted,
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ borderTop: '1px solid ' + BRAND.border, background: BRAND.paper, padding: '10px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <Tab id="deal" label="Deal" />
        <Tab id="company" label="Customer" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={mode === 'deal' ? 'Search deals by company, title or number…' : 'Search customers by name…'}
          style={{ flex: 1, padding: '6px 10px', borderRadius: 8, border: '1px solid ' + BRAND.border, fontSize: 13 }}
        />
        {(linkedDeal || linkedCompany) && (
          <button type="button" onClick={() => (linkedCompany ? onPickCompany(null) : onPickDeal(null))} className="btn-ghost" style={{ fontSize: 12 }}>Unlink</button>
        )}
        <button type="button" onClick={onClose} className="btn-ghost" style={{ fontSize: 12 }}>Cancel</button>
      </div>
      <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {mode === 'deal' ? (
          deals === null ? (
            <div style={{ fontSize: 12, color: BRAND.muted, padding: '6px 4px' }}>Loading deals…</div>
          ) : filteredDeals.length === 0 ? (
            <div style={{ fontSize: 12, color: BRAND.muted, padding: '6px 4px' }}>No matching deals.</div>
          ) : filteredDeals.map((d) => (
            <button
              key={d.dealId}
              type="button"
              onClick={() => onPickDeal(d.dealId)}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'white'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              style={{ display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: '6px 8px', borderRadius: 6 }}
            >
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {d.company || d.title || 'Untitled deal'}
              </span>
              {d.number && <span style={{ fontSize: 11, fontWeight: 600, color: BRAND.muted, flexShrink: 0 }}>{formatProposalNumber(d.number)}</span>}
              <span style={{ fontSize: 12, color: BRAND.muted, flexShrink: 0 }}>{formatGBP(d.net)} net</span>
            </button>
          ))
        ) : (
          !needle ? (
            <div style={{ fontSize: 12, color: BRAND.muted, padding: '6px 4px' }}>Start typing to search customers…</div>
          ) : filteredCompanies.length === 0 ? (
            <div style={{ fontSize: 12, color: BRAND.muted, padding: '6px 4px' }}>No matching customers.</div>
          ) : filteredCompanies.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPickCompany(c.id)}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'white'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              style={{ display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', padding: '6px 8px', borderRadius: 6 }}
            >
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.name}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

const parsePpMoney = (raw) => Number(String(raw ?? '').replace(/[£$,\s]/g, '')) || 0;

// Parse pasted rows from the sheet's "PP's" tab (TAB-separated; descriptions can
// contain commas, so never split on commas). Column order matches the sheet:
// Invoice Type, Description, Company, Price Exc VAT, Payment Method, VAT, Order Date.
function parsePendingPaste(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = line.split('\t').map((x) => x.trim());
    if ((c[0] || '').toLowerCase() === 'invoice type') continue; // header
    const row = {
      invoiceType: c[0] || '',
      description: c[1] || '',
      company: c[2] || '',
      amountExVat: parsePpMoney(c[3]),
      paymentMethod: c[4] || '',
      vat: parsePpMoney(c[5]),
      note: c[6] || '',
    };
    if (!row.company && !row.description && !row.amountExVat) continue;
    out.push({ ...row, kind: 'pp' });
  }
  return out;
}

// Parse pasted rows from the sheet's "PO's" tab (TAB-separated). Column order:
// Type, Description, Project, Quote, PO Number, VAT, Confirmed Date, PO Received,
// Invoice Sent, Invoice, Expected pay date.
function parsePoPaste(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = line.split('\t').map((x) => x.trim());
    if ((c[0] || '').toLowerCase() === 'type') continue; // header
    const note = [c[6] && ('Confirmed ' + c[6]), c[10] && ('Expected ' + c[10])].filter(Boolean).join(' · ');
    const row = {
      kind: 'po',
      invoiceType: c[0] || '',
      description: c[1] || '',
      company: c[2] || '',
      amountExVat: parsePpMoney(c[3]),
      poNumber: c[4] || '',
      vat: parsePpMoney(c[5]),
      note,
    };
    if (!row.company && !row.description && !row.amountExVat) continue;
    out.push(row);
  }
  return out;
}

function PendingImportPanel({ actions, count, isMobile, kind = 'pp' }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [mode, setMode] = useState('replace');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const isPo = kind === 'po';

  const parsed = useMemo(() => (isPo ? parsePoPaste(text) : parsePendingPaste(text)), [text, isPo]);

  const submit = async () => {
    if (!parsed.length || busy || !actions) return;
    setBusy(true); setResult(null);
    try {
      const data = await actions.importPendingPayments(parsed, mode, kind);
      setResult({ ok: true, saved: data?.saved ?? parsed.length });
      setText('');
    } catch {
      setResult({ ok: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ margin: '0 14px 0', borderTop: '1px solid ' + BRAND.border, padding: '12px 0' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
      >
        <ChevronDown size={16} color={BRAND.muted} style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          {isPo ? 'Import POs from the sheet' : 'Import pending payments from the sheet'}
        </span>
      </button>

      {open && (
        <div style={{ marginTop: 14 }}>
          <p style={{ margin: '0 0 10px', fontSize: 12, color: BRAND.muted }}>
            {isPo ? (
              <>Paste the rows from the sheet's <strong>PO's</strong> tab (tab separated, in sheet order):
              <strong> Type, Description, Project, Quote, PO Number, VAT, Confirmed Date, PO Received, Invoice Sent, Invoice, Expected pay date</strong>. A header row is ignored.</>
            ) : (
              <>Paste the rows from the sheet's <strong>PP's</strong> tab (tab separated, in sheet order):
              <strong> Invoice Type, Description, Company, Price Exc VAT, Payment Method, VAT, Order Date</strong>. A header row is ignored.</>
            )}
            <strong> Replace all</strong> swaps the whole imported {isPo ? 'PO' : 'PP'} list for what you paste.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={isPo
              ? 'PO Full\tLLR Video #9\t#9 Somerset Safeguarding\t255.00\t40051210\t51.00\t…'
              : 'Final\t50% Final\tHilary Maxwell - GO Girls\t410.00\tPP\t82.00\t…'}
            rows={8}
            style={{ width: '100%', boxSizing: 'border-box', padding: 10, borderRadius: 8, border: '1px solid ' + BRAND.border, fontSize: 13, fontFamily: 'monospace', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: BRAND.ink, cursor: 'pointer' }}>
              <input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /> Replace all
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: BRAND.ink, cursor: 'pointer' }}>
              <input type="radio" checked={mode === 'merge'} onChange={() => setMode('merge')} /> Add to list
            </label>
            <span style={{ fontSize: 12, color: BRAND.muted }}>{parsed.length} {parsed.length === 1 ? 'row' : 'rows'} detected</span>
            <button onClick={submit} className="btn" disabled={!parsed.length || busy} style={{ marginLeft: 'auto' }}>
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>
          {result && (
            <div style={{ marginTop: 10, fontSize: 13, color: result.ok ? '#15803D' : '#EF4444' }}>
              {result.ok ? `Imported ${result.saved} rows.` : 'Import failed — please try again.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Purchase Orders — one unified list combining CRM signed-deal POs (computed,
// click-through to the deal) with imported Live Sales Sheet POs (manual rows with
// invoice/paid/remove actions + the sheet import panel). A single header carries
// the combined grand total; each row type keeps its own behaviour.
function PurchaseOrdersPanel({ crmRows, crmTotal, importedRows, actions, onChanged, onOpenDeal, onOpenCompany, onCreateInvoice, onMarkPoReceived, companies, isMobile }) {
  const importedNet = importedRows.reduce((s, r) => s + (Number(r.amountExVat) || 0), 0);
  const grand = (Number(crmTotal) || 0) + importedNet;
  const count = crmRows.length + importedRows.length;
  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border, borderLeft: '3px solid #8B5CF6' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink }}>Purchase Orders</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: BRAND.ink }}>{formatGBP(grand)}</span>
        </div>
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>Paid regardless of project stage · signed deals + imported sheet · {count} {count === 1 ? 'item' : 'items'} · use the ⋮ menu on a row for its actions</div>
      </div>
      {crmRows.map((d) => (
        <PendingRow key={d.dealId} d={d} onOpenDeal={onOpenDeal} onCreateInvoice={onCreateInvoice} isPo onMarkPoReceived={onMarkPoReceived} />
      ))}
      <ManualPendingGroup
        bare
        kind="po"
        accent="#8B5CF6"
        rows={importedRows}
        total={importedNet}
        actions={actions}
        onChanged={onChanged}
        onOpenDeal={onOpenDeal}
        onOpenCompany={onOpenCompany}
        companies={companies}
        isMobile={isMobile}
      />
    </div>
  );
}

// Where each payment came from, for the Income ledger's source badge.
const SOURCE_META = {
  stripe: { label: 'Card', color: '#1D4ED8', bg: '#EFF6FF' },
  partner: { label: 'Partner', color: '#6D28D9', bg: '#F5F3FF' },
  manual: { label: 'Manual', color: '#B45309', bg: '#FFFBEB' },
  invoice: { label: 'Invoice', color: '#15803D', bg: '#ECFDF3' },
  billing: { label: 'Billing', color: '#0E7490', bg: '#ECFEFF' },
  sheet: { label: 'PP', color: '#0E7490', bg: '#ECFEFF' },
};

function SourceBadge({ source }) {
  const m = SOURCE_META[source] || SOURCE_META.manual;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: m.color, background: m.bg, padding: '1px 6px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>
      {m.label}
    </span>
  );
}

// How a payment was made, normalised for display (Stripe / BACS / …).
function methodLabel(m) {
  if (!m) return null;
  const s = String(m).toLowerCase();
  if (s.includes('stripe') || s === 'card') return 'Stripe';
  if (s === 'bacs' || s === 'bank' || s === 'transfer' || s === 'bank-transfer') return 'BACS';
  if (s === 'xero') return 'Xero';
  if (s === 'cash') return 'Cash';
  return m.charAt(0).toUpperCase() + m.slice(1);
}

const METHOD_BG = { Stripe: { color: '#1D4ED8', bg: '#EFF6FF' }, BACS: { color: '#15803D', bg: '#ECFDF3' } };

function MethodBadge({ method }) {
  const label = methodLabel(method);
  if (!label) return null;
  const c = METHOD_BG[label] || { color: BRAND.muted, bg: BRAND.paper };
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: c.color, background: c.bg, padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap', flexShrink: 0 }}>
      {label}
    </span>
  );
}

// Income — a flat, newest-first ledger of payments received in the selected
// period. Mirrors the Pending Payments panel visually but each row is one
// payment (money in) rather than an outstanding deal balance.
function IncomePayments({ income, onOpenDeal, isMobile, periodLabel, onSetDate }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 12 : 20, marginTop: 4 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
        Income — {periodLabel}
      </h3>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: BRAND.muted }}>
        Payments received in {periodLabel}, shown ex-VAT (net). Newest first.
      </p>
      {!income ? (
        <div style={{ padding: '12px 4px', fontSize: 13, color: BRAND.muted }}>Loading…</div>
      ) : income.rows.length === 0 ? (
        <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 14, fontSize: 13, color: BRAND.muted, fontStyle: 'italic' }}>
          No payments in this period.
        </div>
      ) : (
        <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border, borderLeft: `3px solid ${BRAND.blue}`, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 12, color: BRAND.muted }}>{income.rows.length} {income.rows.length === 1 ? 'payment' : 'payments'}</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: BRAND.ink }}>{formatGBP(income.total)}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {income.rows.map((r, i) => (
              <IncomeRow key={i} r={r} onOpenDeal={onOpenDeal} onSetDate={onSetDate} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function IncomeRow({ r, onOpenDeal, onSetDate }) {
  const [editing, setEditing] = useState(false);
  const name = r.company || 'Unattributed';
  const number = r.number ? formatProposalNumber(r.number) : '';
  const date = r.paidAt ? new Date(r.paidAt).toLocaleDateString('en-GB') : '';
  const isoDate = r.paidAt ? r.paidAt.slice(0, 10) : '';
  const canEditDate = !!(onSetDate && r.editKey);
  const canOpen = !!(onOpenDeal && r.dealId);
  const open = () => { if (canOpen) onOpenDeal(r.dealId); };
  const commit = (e) => {
    const v = e.target.value;
    setEditing(false);
    if (v && v !== isoDate) onSetDate(r, v);
  };
  return (
    <div
      role={canOpen ? 'button' : undefined}
      tabIndex={canOpen ? 0 : undefined}
      onClick={open}
      onKeyDown={(e) => { if (canOpen && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } }}
      onMouseEnter={(e) => { if (canOpen) e.currentTarget.style.background = BRAND.paper; }}
      onMouseLeave={(e) => { if (canOpen) e.currentTarget.style.background = 'white'; }}
      style={{ borderTop: '1px solid ' + BRAND.border, background: 'white', cursor: canOpen ? 'pointer' : 'default', padding: '8px 14px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {name}
          </span>
          {number && <span style={{ fontSize: 11, fontWeight: 600, color: BRAND.muted, flexShrink: 0 }}>{number}</span>}
          {/* Imported sheet payments are no longer "pending" once paid — drop the PP pill. */}
          {r.source !== 'sheet' && <SourceBadge source={r.source} />}
          <MethodBadge method={r.method} />
          {editing ? (
            <input
              type="date"
              defaultValue={isoDate}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onChange={commit}
              onBlur={() => setEditing(false)}
              style={{ fontSize: 12, padding: '1px 4px', border: '1px solid ' + BRAND.blue, borderRadius: 4, flexShrink: 0 }}
            />
          ) : date && (
            canEditDate ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setEditing(true); }}
                title="Click to change the payment date"
                style={{ fontSize: 12, color: BRAND.muted, flexShrink: 0, background: 'none', border: 'none', borderBottom: '1px dashed ' + BRAND.border, cursor: 'pointer', padding: 0 }}
              >
                {date}
              </button>
            ) : (
              <span style={{ fontSize: 12, color: BRAND.muted, flexShrink: 0 }}>{date}</span>
            )
          )}
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink, flexShrink: 0 }}>{formatGBP(r.net)}</div>
      </div>
    </div>
  );
}

// Where a sales-ledger row came from: a deal signing, an ad-hoc extra, or an
// ad-hoc invoice raised without a signed proposal.
const SALES_SOURCE_META = {
  signed: { label: 'Signed', color: '#15803D', bg: '#ECFDF3' },
  extra: { label: 'Extra', color: '#C2410C', bg: '#FFF7ED' },
  invoice: { label: 'Invoice', color: '#0369A1', bg: '#E0F2FE' },
};

function SalesSourceBadge({ source }) {
  const m = SALES_SOURCE_META[source] || SALES_SOURCE_META.signed;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: m.color, background: m.bg, padding: '1px 6px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>
      {m.label}
    </span>
  );
}

// Sales — a flat, newest-first ledger of cash GENERATED in the period: one row
// per deal signed (its net signed value) and one per extra. Mirrors the Income
// ledger so the two breakdowns read identically.
function SalesLedgerPanel({ ledger, onOpenDeal, isMobile, periodLabel }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 12 : 20, marginTop: 4 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
        Cash generated — {periodLabel}
      </h3>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: BRAND.muted }}>
        New business signed and extras added in {periodLabel}, shown ex-VAT (net). Newest first.
      </p>
      {!ledger ? (
        <div style={{ padding: '12px 4px', fontSize: 13, color: BRAND.muted }}>Loading…</div>
      ) : ledger.rows.length === 0 ? (
        <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 14, fontSize: 13, color: BRAND.muted, fontStyle: 'italic' }}>
          No sales in this period.
        </div>
      ) : (
        <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border, borderLeft: `3px solid ${BRAND.blue}`, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 12, color: BRAND.muted }}>{ledger.rows.length} {ledger.rows.length === 1 ? 'item' : 'items'}</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: BRAND.ink }}>{formatGBP(ledger.total)}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {ledger.rows.map((r, i) => (
              <SalesRow key={i} r={r} onOpenDeal={onOpenDeal} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SalesRow({ r, onOpenDeal }) {
  const name = r.company || ((r.source === 'extra' || r.source === 'invoice') ? (r.label || (r.source === 'invoice' ? 'Invoice' : 'Extra')) : 'Unattributed');
  const number = r.number ? formatProposalNumber(r.number) : '';
  const date = r.at ? new Date(r.at).toLocaleDateString('en-GB') : '';
  const canOpen = !!(onOpenDeal && r.dealId);
  const open = () => { if (canOpen) onOpenDeal(r.dealId); };
  return (
    <div
      role={canOpen ? 'button' : undefined}
      tabIndex={canOpen ? 0 : undefined}
      onClick={open}
      onKeyDown={(e) => { if (canOpen && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } }}
      onMouseEnter={(e) => { if (canOpen) e.currentTarget.style.background = BRAND.paper; }}
      onMouseLeave={(e) => { if (canOpen) e.currentTarget.style.background = 'white'; }}
      style={{ borderTop: '1px solid ' + BRAND.border, background: 'white', cursor: canOpen ? 'pointer' : 'default', padding: '8px 14px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {name}
          </span>
          {number && <span style={{ fontSize: 11, fontWeight: 600, color: BRAND.muted, flexShrink: 0 }}>{number}</span>}
          <SalesSourceBadge source={r.source} />
          {(r.source === 'extra' || r.source === 'invoice') && r.company && r.label && (
            <span style={{ fontSize: 12, color: BRAND.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
              {r.label}
            </span>
          )}
          {date && <span style={{ fontSize: 12, color: BRAND.muted, flexShrink: 0 }}>{date}</span>}
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink, flexShrink: 0 }}>{formatGBP(r.net)}</div>
      </div>
    </div>
  );
}

function PaymentBadge({ type }) {
  const m = PAYMENT_TYPE_META[type] || PAYMENT_TYPE_META.full;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: m.color, background: m.bg, padding: '1px 6px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>
      {m.label}
    </span>
  );
}

// Amber tag for an outstanding line that hasn't been invoiced yet.
function NotInvoicedTag() {
  return (
    <span style={{ fontSize: 9, fontWeight: 700, color: '#B45309', background: '#FFFBEB', padding: '1px 5px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>
      Not invoiced
    </span>
  );
}

// Marks a row the user expects to be paid this month (drives the Predicted tab).
// `auto` rows (active partners) are always predicted, not manually flagged.
function PredictedTag({ auto = false }) {
  return (
    <span title={auto ? 'Always predicted while the partner is active' : 'Predicted to pay this month'} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9, fontWeight: 700, color: PREDICT_COLOR, background: '#F5F3FF', padding: '1px 5px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>
      <CalendarCheck size={10} /> {auto ? 'Predicted (auto)' : 'Predicted'}
    </span>
  );
}

// PO status pill: amber "Pending PO" until the PO is received, then a green
// "PO <number>" once recorded. Shown only on PO-route deal rows.
function PoStatusPill({ d }) {
  const received = !!d.poReceivedAt;
  const color = received ? '#15803D' : '#B45309';
  const bg = received ? '#ECFDF3' : '#FFFBEB';
  return (
    <span style={{ fontSize: 9, fontWeight: 700, color, background: bg, padding: '1px 5px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>
      {received ? `PO ${d.poNumber || ''}`.trim() : 'Pending PO'}
    </span>
  );
}

// Generic per-row kebab (⋮) actions menu — used on EVERY Pending Payments row so
// the action affordance is consistent. `items` is an array of
// { label, icon, onClick, danger? }; falsy entries are skipped. Renders nothing
// when there are no actions.
function RowActionsMenu({ items }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null); // { top, left } in viewport coords
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const visible = (items || []).filter(Boolean);
  const MENU_W = 200;
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    // The menu is fixed-positioned (rendered in a portal so the panels'
    // overflow:hidden can't clip it) — close it on scroll/resize so it never
    // drifts away from its row.
    const close = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  if (!visible.length) return null;
  const toggle = (e) => {
    e.stopPropagation();
    if (open) { setOpen(false); return; }
    const r = btnRef.current.getBoundingClientRect();
    const estH = visible.length * 34 + 8;
    // Flip above the button if there isn't room below.
    const top = (r.bottom + estH > window.innerHeight - 8 && r.top - estH > 8) ? r.top - estH - 4 : r.bottom + 4;
    setPos({ top, left: Math.max(8, r.right - MENU_W) });
    setOpen(true);
  };
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title="Actions"
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6, border: '1px solid ' + BRAND.border, background: open ? BRAND.paper : 'white', cursor: 'pointer', color: BRAND.ink }}
      >
        <MoreVertical size={15} />
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} role="menu" style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 1000, width: MENU_W, background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 8, boxShadow: '0 8px 24px rgba(15,42,61,0.18)', padding: 4 }}>
          {visible.map((it) => {
            const Icon = it.icon;
            return (
              <button
                key={it.label}
                role="menuitem"
                onClick={(e) => { e.stopPropagation(); setOpen(false); it.onClick(); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 10px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, color: it.danger ? '#B91C1C' : BRAND.ink, borderRadius: 6 }}
                onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.paper; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                {Icon && <Icon size={14} />} {it.label}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

function PendingRow({ d, onOpenDeal, onCreateInvoice, isPo = false, onMarkPoReceived }) {
  const predict = usePredict();
  const [predictingDate, setPredictingDate] = useState(false);
  const name = d.company || d.title || 'Untitled deal';
  // Only keep the deal title as a second line when it adds something beyond the
  // company name (avoids showing e.g. "Beyond PR" twice).
  const subtitle = d.company && d.title && d.title !== d.company ? d.title : null;
  const number = d.number ? formatProposalNumber(d.number) : '';
  const lines = d.lines && d.lines.length ? d.lines : [{ type: 'full', amount: d.outstanding }];
  const single = lines.length === 1;
  const single0 = single ? lines[0] : null;
  const showCommitted = Math.abs((d.committed || 0) - (d.outstanding || 0)) > 0.005;
  // A not-yet-invoiced line of a real deal can be invoiced (not extras, which ride
  // on the final invoice; not company-level invoice rows with no dealId).
  const canInvoice = (l) => !!(onCreateInvoice && d.dealId && l.invoiced === false && l.type !== 'extra');
  // Deal rows open the deal; company-level invoice rows (no dealId) open the company.
  const open = () => onOpenDeal && onOpenDeal(d.dealId || d.companyId);
  // Every row's actions live behind the shared ⋮ menu. PO deals lead with their
  // PO action; then one "Create invoice" per not-yet-invoiced line (labelled by
  // its portion when there's more than one); then "Open deal".
  const invoiceLines = lines.filter(canInvoice);
  const rowActions = [
    isPo && onMarkPoReceived && {
      label: d.poReceivedAt ? 'Edit PO number' : 'Mark PO received', icon: Check,
      onClick: () => onMarkPoReceived({ dealId: d.dealId, title: d.title, company: d.company, poNumber: d.poNumber || '' }),
    },
    ...invoiceLines.map((l) => ({
      label: invoiceLines.length > 1 ? `Invoice ${PAYMENT_TYPE_META[l.type]?.label || 'amount'}` : 'Create invoice',
      icon: FileText,
      onClick: () => onCreateInvoice({ dealId: d.dealId, companyId: d.companyId, title: d.title || d.company, stage: d.stage, mode: l.type === 'final' ? 'final' : undefined, reference: isPo ? (d.poNumber || undefined) : undefined }),
    })),
    onOpenDeal && { label: 'Open deal', icon: ExternalLink, onClick: open },
    d.dealId && predictMenuItem(predict, { key: predictKeyForDeal(d.dealId), label: name, amount: d.outstanding }),
    d.dealId && predictDateMenuItem(predict, { key: predictKeyForDeal(d.dealId) }, () => setPredictingDate(true)),
  ];
  const isPredicted = !!(d.dealId && predict?.keys.has(predictKeyForDeal(d.dealId)));
  return (
    <>
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
      onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.paper; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'white'; }}
      style={{ borderTop: '1px solid ' + BRAND.border, background: 'white', cursor: onOpenDeal ? 'pointer' : 'default', padding: '8px 14px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {name}
          </span>
          {number && <span style={{ fontSize: 11, fontWeight: 600, color: BRAND.muted, flexShrink: 0 }}>{number}</span>}
          {single && <PaymentBadge type={single0.type} />}
          {isPo && <PoStatusPill d={d} />}
          {isPredicted && <PredictedTag />}
          {single && single0.invoiced === false && <NotInvoicedTag />}
          {single && single0.label && (
            <span style={{ fontSize: 12, color: BRAND.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
              {single0.label}
            </span>
          )}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink }}>{formatGBP(d.outstanding)}</div>
          {showCommitted && <div style={{ fontSize: 11, color: BRAND.muted }}>of {formatGBP(d.committed)}</div>}
        </div>
        <RowActionsMenu items={rowActions} />
      </div>
      {subtitle && (
        <div style={{ fontSize: 12, color: BRAND.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {subtitle}
        </div>
      )}
      {!single && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
          {lines.map((l, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <PaymentBadge type={l.type} />
                {l.invoiced === false && <NotInvoicedTag />}
                {l.label && (
                  <span style={{ fontSize: 12, color: BRAND.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
                    {l.label}
                  </span>
                )}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: BRAND.ink }}>{formatGBP(l.amount)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
    {predictingDate && (
      <PredictDateModal
        label={name}
        onClose={() => setPredictingDate(false)}
        onConfirm={(month) => predict.predictInMonth({ key: predictKeyForDeal(d.dealId), label: name, amount: d.outstanding }, month)}
      />
    )}
    </>
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden', background: 'white' }}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{
            padding: '8px 14px', border: 'none', cursor: 'pointer', fontSize: 14,
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

// The "VAT — Q{n}" headline card, but clickable: opens a dropdown of all four
// quarters (VAT + net) to jump into a quarter view, replacing the old always-on
// quarters strip.
function QuarterMenuCard({ quarters, currentIdx, label, value, onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onEsc); };
  }, [open]);
  const list = quarters || [];
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          width: '100%', height: '100%', textAlign: 'left', cursor: 'pointer', boxSizing: 'border-box',
          background: 'white', border: '1px solid ' + (open ? BRAND.blue : BRAND.border),
          borderLeft: `3px solid ${VAT_COLOR}`, borderRadius: 10, padding: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
          <Landmark size={14} color={VAT_COLOR} />
          <span style={{ flex: 1 }}>{label}</span>
          <ChevronDown size={14} style={{ opacity: 0.6, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
        </div>
        <div style={{ fontSize: 24, fontWeight: 700, color: BRAND.ink }}>{value}</div>
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>Click to view any quarter</div>
      </button>
      {open && list.length > 0 && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0,
            background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10,
            boxShadow: '0 8px 24px rgba(15, 42, 61, 0.12)', padding: 6, zIndex: 50,
            display: 'flex', flexDirection: 'column', gap: 2,
          }}
        >
          {list.map((q, i) => (
            <button
              key={q.label}
              type="button"
              role="menuitem"
              onClick={() => { onPick(i); setOpen(false); }}
              onMouseEnter={(e) => { e.currentTarget.style.background = BRAND.paper; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = i === currentIdx ? '#F4FBFE' : 'transparent'; }}
              style={{
                display: 'flex', alignItems: 'baseline', gap: 8, width: '100%',
                padding: '8px 10px', border: 'none', borderRadius: 8, cursor: 'pointer',
                background: i === currentIdx ? '#F4FBFE' : 'transparent', textAlign: 'left',
              }}
            >
              <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: BRAND.ink }}>
                {q.label}{i === currentIdx ? ' · now' : ''}
              </span>
              <span style={{ fontSize: 14, fontWeight: 700, color: VAT_COLOR }}>{formatGBP(q.vat)}</span>
              <span style={{ fontSize: 12, color: BRAND.muted }}>{formatGBP(q.net)} net</span>
            </button>
          ))}
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
