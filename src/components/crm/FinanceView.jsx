import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, PoundSterling, PiggyBank, Wallet, Landmark, ChevronDown, Trash2 } from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { api } from '../../api.js';
import { formatGBP, formatProposalNumber, useIsMobile } from '../../utils.js';

const VAT_COLOR = '#F59E0B';
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

export function FinanceView({ onBack, onOpenDeal }) {
  const { state, actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const now = new Date();
  const [mode, setMode] = useState('year'); // 'month' | 'quarter' | 'year'
  const [year, setYear] = useState(() => now.getFullYear());
  const [quarterKey, setQuarterKey] = useState(() => recentQuarters(1)[0]); // 'YYYY-Qn'
  const [monthKey, setMonthKey] = useState(() => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`); // 'YYYY-MM'
  const [loading, setLoading] = useState(true);

  // Which year's data we need (a chosen quarter / month dictates its own year).
  const qYear = Number(quarterKey.split('-Q')[0]);
  const qIdx = Number(quarterKey.split('-Q')[1]) - 1;
  const effectiveYear = mode === 'year' ? year : (mode === 'month' ? Number(monthKey.slice(0, 4)) : qYear);

  useEffect(() => {
    let active = true;
    setLoading(true);
    actions.loadFinanceStats(effectiveYear).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [actions, effectiveYear]);

  // Outstanding deals aren't period-scoped — load once.
  useEffect(() => { actions.loadPendingPayments(); }, [actions]);

  const fin = state.financeStats && state.financeStats.year === effectiveYear ? state.financeStats : null;
  const pending = state.pendingPayments;

  // Remove an ad-hoc extra straight from the Pending Payments list (it's the
  // only line type that's a standalone record). Deletes it from the deal too,
  // then re-pulls so the list reflects reality.
  const handleDeleteExtra = async (extraId) => {
    if (!extraId) return;
    if (!window.confirm('Remove this extra charge? It will be deleted from the deal as well.')) return;
    try {
      await api.delete('/api/crm/extras/' + encodeURIComponent(extraId));
    } catch (err) {
      showMsg?.(err.message || 'Failed to remove extra', 'error');
    }
    actions.loadPendingPayments();
  };
  const isCurrentYear = effectiveYear === now.getFullYear();
  const monthIdx = now.getMonth();

  const view = useMemo(() => {
    const months = fin?.months || [];
    const quarters = fin?.quarters || [];
    const yearTotals = months.reduce((a, m) => ({ net: a.net + m.net, vat: a.vat + m.vat, gross: a.gross + m.gross }), { net: 0, vat: 0, gross: 0 });

    const zero = { net: 0, vat: 0, gross: 0 };
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
  }, [fin, mode, qIdx, monthKey, isCurrentYear, monthIdx, effectiveYear]);

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
            <p style={{ fontSize: 13, color: BRAND.muted, margin: '2px 0 0' }}>
              Cash received across all customers. Figures are ex-VAT (net); VAT to set aside is shown separately.
            </p>
          </div>
        </div>
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
      </header>

      {/* Headline cards. VAT-to-save is the headline ask. */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        {mode !== 'year' ? (
          <>
            <StatCard icon={PiggyBank} accent={VAT_COLOR} label={`VAT to set aside — ${view.periodLabel}`} value={formatGBP(view.totals.vat)} sub={`Set aside for ${view.periodLabel}`} />
            <StatCard icon={Wallet} accent={BRAND.blue} label={`Net revenue (ex-VAT) — ${view.periodLabel}`} value={formatGBP(view.totals.net)} sub={`${formatGBP(view.totals.gross)} gross banked`} />
            <StatCard icon={Landmark} accent={BRAND.ink} label={`Gross banked — ${view.periodLabel}`} value={formatGBP(view.totals.gross)} sub="Net + VAT received" />
            <StatCard icon={PoundSterling} accent={BRAND.ink} label="Outstanding — all customers" value={formatGBP(fin ? fin.outstanding : 0)} sub="Still to collect (inc VAT)" />
          </>
        ) : (
          <>
            <StatCard icon={PiggyBank} accent={VAT_COLOR} label={view.thisMonth ? `VAT to set aside — ${shortMonth(view.thisMonth.month)}` : `VAT to set aside — ${effectiveYear}`} value={formatGBP(view.thisMonth ? view.thisMonth.vat : view.totals.vat)} sub={view.thisMonth ? 'From cash banked this month' : 'Total for the year'} />
            <QuarterMenuCard
              quarters={view.quarters}
              currentIdx={isCurrentYear ? Math.floor(monthIdx / 3) : -1}
              label={isCurrentYear && view.thisQuarter ? `VAT — ${view.thisQuarter.label}` : `VAT — ${effectiveYear}`}
              value={formatGBP(isCurrentYear && view.thisQuarter ? view.thisQuarter.vat : view.totals.vat)}
              onPick={(i) => { setQuarterKey(`${effectiveYear}-Q${i + 1}`); setMode('quarter'); }}
            />
            <StatCard icon={Wallet} accent={BRAND.blue} label={isCurrentYear ? 'Net revenue (ex-VAT) — YTD' : `Net revenue (ex-VAT) — ${effectiveYear}`} value={formatGBP(fin ? fin.ytd.net : 0)} sub={`${formatGBP(view.totals.gross)} gross banked`} />
            <StatCard icon={PoundSterling} accent={BRAND.ink} label="Outstanding — all customers" value={formatGBP(fin ? fin.outstanding : 0)} sub="Still to collect (inc VAT)" />
          </>
        )}
      </div>

      {/* VAT-to-save bar chart, with net for context. */}
      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 12 : 20, marginBottom: 20 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          VAT to set aside — {view.periodLabel}
        </h3>
        {loading ? (
          <div style={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', color: BRAND.muted, fontSize: 14 }}>Loading…</div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={view.chart} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={BRAND.border} />
              <XAxis dataKey="label" tick={{ fontSize: 12, fill: BRAND.muted }} />
              <YAxis tickFormatter={gbpK} tick={{ fontSize: 12, fill: BRAND.muted }} width={56} />
              <Tooltip formatter={(v, n) => [formatGBP(v), n]} cursor={{ fill: 'rgba(43,184,230,0.06)' }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="net" name="Net revenue (ex-VAT)" fill={BRAND.blue} radius={[4, 4, 0, 0]} />
              <Bar dataKey="vat" name="VAT to set aside" fill={VAT_COLOR} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

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
                  <td style={{ textAlign: 'right', padding: '10px 8px' }}>{formatGBP(view.totals.gross)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Pending Payments — outstanding signed deals, split PO vs normal. */}
      <PendingPayments pending={pending} onOpenDeal={onOpenDeal} onDeleteExtra={handleDeleteExtra} isMobile={isMobile} />
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
};

function PendingPayments({ pending, onOpenDeal, onDeleteExtra, isMobile }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 12 : 20, marginTop: 20 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
        Pending Payments
      </h3>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: BRAND.muted }}>
        Outstanding balances on signed deals — shown ex-VAT (net). 50/50 deals split into the invoiced deposit (awaiting payment) and the final still to invoice.
      </p>
      {!pending ? (
        <div style={{ padding: '12px 4px', fontSize: 13, color: BRAND.muted }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <PendingGroup
            title="Invoiced work"
            note="Paid on project milestones / completion"
            rows={pending.normal}
            total={pending.totals.normal}
            accent={BRAND.blue}
            onOpenDeal={onOpenDeal}
            onDeleteExtra={onDeleteExtra}
          />
          <PendingGroup
            title="Purchase Orders"
            note="Paid regardless of project stage"
            rows={pending.po}
            total={pending.totals.po}
            accent="#8B5CF6"
            onOpenDeal={onOpenDeal}
            onDeleteExtra={onDeleteExtra}
          />
        </div>
      )}
    </div>
  );
}

function PendingGroup({ title, note, rows, total, accent, onOpenDeal, onDeleteExtra }) {
  return (
    <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid ' + BRAND.border, borderLeft: `3px solid ${accent}` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: BRAND.ink }}>{title}</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: BRAND.ink }}>{formatGBP(total)}</span>
        </div>
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>{note} · {rows.length} {rows.length === 1 ? 'deal' : 'deals'}</div>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: 14, fontSize: 13, color: BRAND.muted, fontStyle: 'italic' }}>Nothing outstanding.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {rows.map((d) => (
            <PendingRow key={d.dealId} d={d} onOpenDeal={onOpenDeal} onDeleteExtra={onDeleteExtra} />
          ))}
        </div>
      )}
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

function ExtraDeleteButton({ onClick, disabled }) {
  const title = disabled
    ? 'On an invoice — void or delete that invoice to remove this extra'
    : 'Remove extra';
  return (
    <button
      onClick={disabled ? (e) => e.stopPropagation() : onClick}
      className="btn-icon"
      disabled={disabled}
      title={title}
      aria-label={title}
      style={{ flexShrink: 0, color: disabled ? BRAND.muted : '#9A3412', opacity: disabled ? 0.45 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      <Trash2 size={13} />
    </button>
  );
}

function PendingRow({ d, onOpenDeal, onDeleteExtra }) {
  const name = d.company || d.title || 'Untitled deal';
  // Only keep the deal title as a second line when it adds something beyond the
  // company name (avoids showing e.g. "Beyond PR" twice).
  const subtitle = d.company && d.title && d.title !== d.company ? d.title : null;
  const number = d.number ? formatProposalNumber(d.number) : '';
  const lines = d.lines && d.lines.length ? d.lines : [{ type: 'full', amount: d.outstanding }];
  const single = lines.length === 1;
  const single0 = single ? lines[0] : null;
  const showCommitted = Math.abs((d.committed || 0) - (d.outstanding || 0)) > 0.005;
  const open = () => onOpenDeal && onOpenDeal(d.dealId);
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
        {single && single0.type === 'extra' && single0.id && onDeleteExtra && (
          <ExtraDeleteButton disabled={single0.status !== 'pending'} onClick={(e) => { e.stopPropagation(); onDeleteExtra(single0.id); }} />
        )}
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
                {l.label && (
                  <span style={{ fontSize: 12, color: BRAND.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
                    {l.label}
                  </span>
                )}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: BRAND.ink }}>{formatGBP(l.amount)}</span>
                {l.type === 'extra' && l.id && onDeleteExtra && (
                  <ExtraDeleteButton disabled={l.status !== 'pending'} onClick={(e) => { e.stopPropagation(); onDeleteExtra(l.id); }} />
                )}
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
