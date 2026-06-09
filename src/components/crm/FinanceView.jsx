import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, PoundSterling, PiggyBank, Wallet, Landmark, ChevronDown } from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, formatProposalNumber, useIsMobile } from '../../utils.js';
import { PerformancePanel } from './PerformanceView.jsx';
import { CreateXeroInvoiceModal } from './CreateXeroInvoiceModal.jsx';

const VAT_COLOR = '#F59E0B';
const CT_COLOR = '#0E7490';
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
  const [section, setSection] = useState(financeViewMemory.section); // 'income' | 'pending' | 'vat'
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

  // Rolling trend (charts) — load 36 months (the Performance comparison needs
  // the full window; the bar charts below slice the last 12). Period-independent.
  useEffect(() => { if (!state.trend) actions.loadTrend(36); }, [actions, state.trend]);
  const trend = state.trend;

  // Reload everything a paid PP touches (pending list + income ledger + net
  // revenue + trend) using the period that's currently selected.
  const refreshFinance = () => {
    actions.loadPendingPayments();
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
  const activePartners = (state.partnerCreditsList || []).filter((p) => p.status === 'active' || p.status === 'credits_only');
  const partnerTotal = activePartners.reduce((s, p) => s + (Number(p.outstanding) || 0), 0);

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
      <PerformancePanel section={perfSection} onSection={setPerfSection} />

      {/* Section tabs — Income (or Sales) / Pending Payments / VAT. The period
          picker lives here, next to the figures it drives, so changing it shows
          a visible change. Pending Payments is all-time, so it's hidden there. */}
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <Segmented
          value={section}
          onChange={setSection}
          options={[{ value: 'income', label: firstTab.label }, { value: 'pending', label: 'Pending Payments' }, { value: 'vat', label: 'VAT & Corp tax' }]}
        />
        {section !== 'pending' && (
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
            <StatCard icon={PoundSterling} accent={BRAND.blue} label="Total pending payments" value={formatGBP((pending?.totals?.invoiced || 0) + (pending?.totals?.notInvoiced || 0) + partnerTotal)} sub="Invoiced + not yet invoiced + partners — all outstanding · ex-VAT (net)" />
          </div>
          {/* Pending Payments — outstanding signed deals, split PO vs normal, plus
              the imported Live Sales Sheet group and active partners. */}
          <PendingPayments pending={pending} partners={activePartners} partnerTotal={partnerTotal} onOpenDeal={onOpenDeal} onOpenCompany={onOpenCompany} onOpenPartner={onOpenPartner} companies={companyOptions} isMobile={isMobile} actions={actions} onChanged={refreshFinance} />
        </>
      )}
    </div>
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

function PendingPayments({ pending, partners, partnerTotal, onOpenDeal, onOpenCompany, onOpenPartner, companies, isMobile, actions, onChanged }) {
  // The deal + portion to invoice when an INV button is clicked (opens the
  // shared Xero create-invoice modal, pre-filled with the deal's suggested lines).
  const [invTarget, setInvTarget] = useState(null);
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 12 : 20, marginTop: 20 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
        Pending Payments
      </h3>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: BRAND.muted }}>
        Invoiced and outstanding amounts awaiting payment — shown ex-VAT (net). Each signed-deal line is tagged "Not invoiced" until raised; hit INV to invoice that portion straight from here.
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
        return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {invoicedManual.length > 0 && (
            <ManualPendingGroup
              title="Invoiced — awaiting payment"
              note="Invoiced items awaiting payment"
              kind="pp"
              variant="invoiced"
              accent={BRAND.blue}
              rows={invoicedManual}
              total={sumNet(invoicedManual)}
              actions={actions}
              onChanged={onChanged}
              onOpenDeal={onOpenDeal}
              onOpenCompany={onOpenCompany}
              companies={companies}
              isMobile={isMobile}
            />
          )}
          <PurchaseOrdersPanel
            crmRows={pending.po || []}
            crmTotal={pending.totals.po}
            importedRows={pos}
            actions={actions}
            onChanged={onChanged}
            onOpenDeal={onOpenDeal}
            onOpenCompany={onOpenCompany}
            onCreateInvoice={setInvTarget}
            companies={companies}
            isMobile={isMobile}
          />
          <SignedDealsPanel
            rows={pending.normal || []}
            total={pending.totals.normal}
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
        </div>
        );
      })()}
      {invTarget && (
        <CreateXeroInvoiceModal
          companyId={invTarget.companyId || undefined}
          dealId={invTarget.companyId ? undefined : invTarget.dealId}
          deals={invTarget.companyId ? [{ id: invTarget.dealId, title: invTarget.title, stage: invTarget.stage || 'signed', company_id: invTarget.companyId }] : undefined}
          initialDealId={invTarget.dealId}
          mode={invTarget.mode}
          onClose={() => setInvTarget(null)}
          onCreated={() => { setInvTarget(null); onChanged && onChanged(); }}
        />
      )}
    </div>
  );
}

// Signed deals (PO and non-PO) with an outstanding balance — each line tagged
// invoiced / not-invoiced, with an INV button on the not-yet-invoiced portions.
function SignedDealsPanel({ rows, total, onOpenDeal, onCreateInvoice, isMobile }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border, borderLeft: `3px solid ${BRAND.blue}` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink }}>Signed deals — outstanding</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: BRAND.ink }}>{formatGBP(total)}</span>
        </div>
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>Signed work still owed · {rows.length} {rows.length === 1 ? 'deal' : 'deals'} · each line tagged invoiced / not invoiced · INV raises an invoice for that portion</div>
      </div>
      {rows.map((d) => (
        <PendingRow key={d.dealId} d={d} onOpenDeal={onOpenDeal} onCreateInvoice={onCreateInvoice} isMobile={isMobile} />
      ))}
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
    if (window.confirm(`Remove "${r.company || r.description || 'this item'}" from the list? (Use this only for mistakes — it is not added to income.)`)) {
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
          <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>{note} · {rows.length} {rows.length === 1 ? 'item' : 'items'} · {isInvoicedGroup ? '✓ marks paid (→ income), ↩ back to pending, ✕ removes' : 'Inv marks invoiced, ✓ marks paid (→ income), ✕ removes'}</div>
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

function ManualPendingRow({ r, cols, isMobile, variant = 'pending', actions, onPaid, onInvoice, onUninvoice, onLink, onLinkCompany, companies, onOpenDeal, onOpenCompany, onRemove }) {
  const [picking, setPicking] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const isInvoicedGroup = variant === 'invoiced';
  const isCompanyInvoice = r.kind === 'company-invoice';
  const linkedDeal = !!r.dealId;
  const linkedCompany = !!r.companyId;
  const linked = linkedDeal || linkedCompany;
  const net = Number(r.amountExVat) || 0;
  const vat = Number(r.vat) || 0;
  const subtitle = [r.invoiceType, r.poNumber, r.description, r.note].filter(Boolean).join(' · ');
  const pay = (method) => { setPicking(false); onPaid(method); };
  // Open whatever the row is linked to — its deal, or its customer.
  const canOpen = (linkedDeal && onOpenDeal) || (linkedCompany && onOpenCompany);
  const openLinked = () => {
    if (linkedDeal && onOpenDeal) onOpenDeal(r.dealId);
    else if (linkedCompany && onOpenCompany) onOpenCompany(r.companyId);
  };
  return (
    <>
    <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, alignItems: 'center', borderTop: '1px solid ' + BRAND.border, background: 'white', padding: '5px 14px' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {isCompanyInvoice ? (
            <span title="A company invoice — not linked to a deal" style={{ fontSize: 9, fontWeight: 700, color: '#B45309', background: '#FFFBEB', padding: '1px 5px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>
              Not linked to a deal
            </span>
          ) : linked ? (
            <span onClick={openLinked}
              title={linkedCompany
                ? (r.linkedCompanyName ? `Linked to customer: ${r.linkedCompanyName}` : 'Linked to a customer')
                : (onOpenDeal ? 'Open linked deal' : 'Linked to a CRM deal')}
              style={{ cursor: canOpen ? 'pointer' : 'default', fontSize: 9, fontWeight: 700, color: '#15803D', background: '#ECFDF3', padding: '1px 5px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>
              {linkedCompany ? 'Customer' : 'Linked'}
            </span>
          ) : (
            <span style={{ fontSize: 9, fontWeight: 700, color: '#0E7490', background: '#ECFEFF', padding: '1px 5px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>
              Imported
            </span>
          )}
          <span onClick={openLinked} style={{ fontSize: 13, fontWeight: 600, color: canOpen ? BRAND.blue : BRAND.ink, cursor: canOpen ? 'pointer' : 'default', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {r.company || 'Unattributed'}
          </span>
          {linkedCompany && r.linkedCompanyName && r.linkedCompanyName !== r.company && (
            <span title={`Linked to customer: ${r.linkedCompanyName}`} style={{ fontSize: 11, color: BRAND.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1 }}>
              → {r.linkedCompanyName}
            </span>
          )}
          {onLink && !isCompanyInvoice && (
            <button type="button" onClick={() => setLinkOpen((v) => !v)} title={linked ? 'Change or remove the link' : 'Link to a deal or customer'}
              style={{ flexShrink: 0, border: 'none', background: 'none', cursor: 'pointer', color: BRAND.muted, fontSize: 11, lineHeight: 1, padding: '1px 3px', textDecoration: 'underline' }}>
              {linked ? 'edit' : 'link'}
            </button>
          )}
        </div>
        {subtitle && (
          <div title={subtitle} style={{ fontSize: 11, color: BRAND.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subtitle}</div>
        )}
      </div>
      <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: BRAND.ink }}>{formatGBP(net)}</div>
      <div style={{ textAlign: 'right', fontSize: 13, color: vat > 0 ? VAT_COLOR : BRAND.muted }}>{formatGBP(vat)}</div>
      {!isMobile && <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 700, color: BRAND.ink }}>{formatGBP(net + vat)}</div>}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
        {isCompanyInvoice ? null : picking ? (
          <>
            {/* Choose how it was paid — both add it to income. */}
            <button type="button" onClick={() => pay('stripe')} title="Mark paid via Stripe"
              style={{ flexShrink: 0, border: '1px solid #1D4ED8', background: '#EFF6FF', color: '#1D4ED8', cursor: 'pointer', fontSize: 11, fontWeight: 700, lineHeight: 1, padding: '3px 6px', borderRadius: 4 }}>
              Stripe
            </button>
            <button type="button" onClick={() => pay('bacs')} title="Mark paid via BACS"
              style={{ flexShrink: 0, border: '1px solid #15803D', background: '#ECFDF3', color: '#15803D', cursor: 'pointer', fontSize: 11, fontWeight: 700, lineHeight: 1, padding: '3px 6px', borderRadius: 4 }}>
              BACS
            </button>
            <button type="button" onClick={() => setPicking(false)} title="Cancel"
              style={{ flexShrink: 0, border: 'none', background: 'none', cursor: 'pointer', color: BRAND.muted, fontSize: 14, lineHeight: 1, padding: '2px 2px' }}>
              ✕
            </button>
          </>
        ) : (
          <>
            {isInvoicedGroup ? (
              <button
                type="button"
                onClick={onUninvoice}
                title="Move back to pending (not invoiced)"
                style={{ flexShrink: 0, border: 'none', background: 'none', cursor: 'pointer', color: BRAND.muted, fontSize: 14, lineHeight: 1, padding: '2px 4px' }}
                onMouseEnter={(e) => { e.currentTarget.style.color = BRAND.ink; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = BRAND.muted; }}
              >
                ↩
              </button>
            ) : (
              <button
                type="button"
                onClick={onInvoice}
                title="Mark invoiced — moves to the invoiced list"
                style={{ flexShrink: 0, border: '1px solid ' + BRAND.border, background: 'white', cursor: 'pointer', color: BRAND.muted, fontSize: 10, fontWeight: 700, lineHeight: 1, padding: '3px 5px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3 }}
                onMouseEnter={(e) => { e.currentTarget.style.color = BRAND.blue; e.currentTarget.style.borderColor = BRAND.blue; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = BRAND.muted; e.currentTarget.style.borderColor = BRAND.border; }}
              >
                Inv
              </button>
            )}
            <button
              type="button"
              onClick={() => setPicking(true)}
              title="Mark paid — add to income"
              style={{ flexShrink: 0, border: 'none', background: 'none', cursor: 'pointer', color: BRAND.muted, fontSize: 15, lineHeight: 1, padding: '2px 4px' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = '#15803D'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = BRAND.muted; }}
            >
              ✓
            </button>
            <button
              type="button"
              onClick={onRemove}
              title="Remove (mistake — not income)"
              style={{ flexShrink: 0, border: 'none', background: 'none', cursor: 'pointer', color: BRAND.muted, fontSize: 15, lineHeight: 1, padding: '2px 4px' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = '#EF4444'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = BRAND.muted; }}
            >
              ✕
            </button>
          </>
        )}
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
  const filteredCompanies = (companies || []).filter((c) => {
    if (!needle) return true;
    return (c.name || '').toLowerCase().includes(needle);
  }).slice(0, 40);

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
          (companies || []).length === 0 ? (
            <div style={{ fontSize: 12, color: BRAND.muted, padding: '6px 4px' }}>No customers found.</div>
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
function PurchaseOrdersPanel({ crmRows, crmTotal, importedRows, actions, onChanged, onOpenDeal, onOpenCompany, onCreateInvoice, companies, isMobile }) {
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
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>Paid regardless of project stage · signed deals + imported sheet · {count} {count === 1 ? 'item' : 'items'} · Inv marks invoiced, ✓ marks paid (→ income), ✕ removes</div>
      </div>
      {crmRows.map((d) => (
        <PendingRow key={d.dealId} d={d} onOpenDeal={onOpenDeal} onCreateInvoice={onCreateInvoice} />
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

// Where a sales-ledger row came from: a deal signing or an ad-hoc extra.
const SALES_SOURCE_META = {
  signed: { label: 'Signed', color: '#15803D', bg: '#ECFDF3' },
  extra: { label: 'Extra', color: '#C2410C', bg: '#FFF7ED' },
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
  const name = r.company || (r.source === 'extra' ? (r.label || 'Extra') : 'Unattributed');
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
          {r.source === 'extra' && r.company && r.label && (
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

// A small INV button that raises an invoice for one outstanding line. Stops the
// row's open-deal click. Maps the line type to the create-invoice mode: a 50%
// final needs mode:'final'; deposit / full / PO use the default suggested lines.
function InvButton({ d, line, onCreateInvoice }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onCreateInvoice({ dealId: d.dealId, companyId: d.companyId, title: d.title || d.company, stage: d.stage, mode: line.type === 'final' ? 'final' : undefined }); }}
      title="Create an invoice for this"
      style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.4, color: '#0E7490', background: '#ECFEFF', border: '1px solid #A5E0EC', borderRadius: 4, padding: '2px 7px', cursor: 'pointer', flexShrink: 0 }}
    >
      INV
    </button>
  );
}

function PendingRow({ d, onOpenDeal, onCreateInvoice }) {
  const name = d.company || d.title || 'Untitled deal';
  // Only keep the deal title as a second line when it adds something beyond the
  // company name (avoids showing e.g. "Beyond PR" twice).
  const subtitle = d.company && d.title && d.title !== d.company ? d.title : null;
  const number = d.number ? formatProposalNumber(d.number) : '';
  const lines = d.lines && d.lines.length ? d.lines : [{ type: 'full', amount: d.outstanding }];
  const single = lines.length === 1;
  const single0 = single ? lines[0] : null;
  const showCommitted = Math.abs((d.committed || 0) - (d.outstanding || 0)) > 0.005;
  // INV button shows on a not-yet-invoiced line of a real deal (not extras, which
  // ride on the final invoice; not company-level invoice rows with no dealId).
  const canInvoice = (l) => !!(onCreateInvoice && d.dealId && l.invoiced === false && l.type !== 'extra');
  // Deal rows open the deal; company-level invoice rows (no dealId) open the company.
  const open = () => onOpenDeal && onOpenDeal(d.dealId || d.companyId);
  return (
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
          {single && single0.invoiced === false && <NotInvoicedTag />}
          {single && single0.label && (
            <span style={{ fontSize: 12, color: BRAND.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
              {single0.label}
            </span>
          )}
        </div>
        {single && single0 && canInvoice(single0) && <InvButton d={d} line={single0} onCreateInvoice={onCreateInvoice} />}
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink }}>{formatGBP(d.outstanding)}</div>
          {showCommitted && <div style={{ fontSize: 11, color: BRAND.muted }}>of {formatGBP(d.committed)}</div>}
        </div>
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
                {canInvoice(l) && <InvButton d={d} line={l} onCreateInvoice={onCreateInvoice} />}
                <span style={{ fontSize: 12, fontWeight: 600, color: BRAND.ink }}>{formatGBP(l.amount)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
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
