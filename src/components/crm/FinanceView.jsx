import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, PoundSterling, PiggyBank, Wallet, Landmark } from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, useIsMobile } from '../../utils.js';

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

export function FinanceView({ onBack }) {
  const { state, actions } = useStore();
  const isMobile = useIsMobile();
  const now = new Date();
  const [mode, setMode] = useState('year'); // 'year' | 'quarter'
  const [year, setYear] = useState(() => now.getFullYear());
  const [quarterKey, setQuarterKey] = useState(() => recentQuarters(1)[0]); // 'YYYY-Qn'
  const [loading, setLoading] = useState(true);

  // Which year's data we need (a chosen quarter dictates its own year).
  const qYear = Number(quarterKey.split('-Q')[0]);
  const qIdx = Number(quarterKey.split('-Q')[1]) - 1;
  const effectiveYear = mode === 'year' ? year : qYear;

  useEffect(() => {
    let active = true;
    setLoading(true);
    actions.loadFinanceStats(effectiveYear).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [actions, effectiveYear]);

  const fin = state.financeStats && state.financeStats.year === effectiveYear ? state.financeStats : null;
  const isCurrentYear = effectiveYear === now.getFullYear();
  const monthIdx = now.getMonth();

  const view = useMemo(() => {
    const months = fin?.months || [];
    const quarters = fin?.quarters || [];
    const yearTotals = months.reduce((a, m) => ({ net: a.net + m.net, vat: a.vat + m.vat, gross: a.gross + m.gross }), { net: 0, vat: 0, gross: 0 });

    const displayMonths = mode === 'quarter' ? months.slice(qIdx * 3, qIdx * 3 + 3) : months;
    const totals = mode === 'quarter'
      ? (quarters[qIdx] || { net: 0, vat: 0, gross: 0 })
      : yearTotals;
    const chart = displayMonths.map((m) => ({ label: shortMonth(m.month), net: m.net, vat: m.vat }));

    const thisMonth = isCurrentYear ? months[monthIdx] : null;
    const thisQuarter = quarters[Math.floor(monthIdx / 3)] || null;
    const periodLabel = mode === 'quarter' ? `Q${qIdx + 1} ${effectiveYear}` : String(effectiveYear);

    return { months, quarters, displayMonths, totals, chart, thisMonth, thisQuarter, periodLabel };
  }, [fin, mode, qIdx, isCurrentYear, monthIdx, effectiveYear]);

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
            options={[{ value: 'year', label: 'Year' }, { value: 'quarter', label: 'Quarter' }]}
          />
          <select
            value={mode === 'year' ? year : quarterKey}
            onChange={(e) => (mode === 'year' ? setYear(Number(e.target.value)) : setQuarterKey(e.target.value))}
            style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid ' + BRAND.border, background: 'white', fontSize: 14, color: BRAND.ink }}
          >
            {mode === 'year'
              ? yearOptions.map((y) => <option key={y} value={y}>{y}</option>)
              : recentQuarters(8).map((k) => { const [y, q] = k.split('-Q'); return <option key={k} value={k}>{`Q${q} ${y}`}</option>; })}
          </select>
        </div>
      </header>

      {/* Headline cards. VAT-to-save is the headline ask. */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        {mode === 'quarter' ? (
          <>
            <StatCard icon={PiggyBank} accent={VAT_COLOR} label={`VAT to set aside — ${view.periodLabel}`} value={formatGBP(view.totals.vat)} sub="Set aside for this quarter" />
            <StatCard icon={Wallet} accent={BRAND.blue} label={`Net revenue (ex-VAT) — ${view.periodLabel}`} value={formatGBP(view.totals.net)} sub={`${formatGBP(view.totals.gross)} gross banked`} />
            <StatCard icon={Landmark} accent={BRAND.ink} label={`Gross banked — ${view.periodLabel}`} value={formatGBP(view.totals.gross)} sub="Net + VAT received" />
            <StatCard icon={PoundSterling} accent={BRAND.ink} label="Outstanding — all customers" value={formatGBP(fin ? fin.outstanding : 0)} sub="Still to collect (inc VAT)" />
          </>
        ) : (
          <>
            <StatCard icon={PiggyBank} accent={VAT_COLOR} label={view.thisMonth ? `VAT to set aside — ${shortMonth(view.thisMonth.month)}` : `VAT to set aside — ${effectiveYear}`} value={formatGBP(view.thisMonth ? view.thisMonth.vat : view.totals.vat)} sub={view.thisMonth ? 'From cash banked this month' : 'Total for the year'} />
            <StatCard icon={Landmark} accent={VAT_COLOR} label={isCurrentYear && view.thisQuarter ? `VAT — ${view.thisQuarter.label}` : `VAT — ${effectiveYear}`} value={formatGBP(isCurrentYear && view.thisQuarter ? view.thisQuarter.vat : view.totals.vat)} sub="UK VAT returns are quarterly" />
            <StatCard icon={Wallet} accent={BRAND.blue} label={isCurrentYear ? 'Net revenue (ex-VAT) — YTD' : `Net revenue (ex-VAT) — ${effectiveYear}`} value={formatGBP(fin ? fin.ytd.net : 0)} sub={`${formatGBP(view.totals.gross)} gross banked`} />
            <StatCard icon={PoundSterling} accent={BRAND.ink} label="Outstanding — all customers" value={formatGBP(fin ? fin.outstanding : 0)} sub="Still to collect (inc VAT)" />
          </>
        )}
      </div>

      {/* Quarters strip (year mode) — eyeball all four, click to drill in. */}
      {mode === 'year' && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
          {view.quarters.map((q, i) => {
            const isThisQ = isCurrentYear && i === Math.floor(monthIdx / 3);
            return (
              <button
                key={q.label}
                onClick={() => { setQuarterKey(`${effectiveYear}-Q${i + 1}`); setMode('quarter'); }}
                title={`View ${q.label}`}
                style={{
                  textAlign: 'left', cursor: 'pointer', background: 'white',
                  border: '1px solid ' + (isThisQ ? BRAND.blue : BRAND.border), borderRadius: 10, padding: 14,
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                  {q.label}{isThisQ ? ' · now' : ''}
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: VAT_COLOR }}>{formatGBP(q.vat)}</div>
                <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>VAT · {formatGBP(q.net)} net</div>
              </button>
            );
          })}
        </div>
      )}

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
            <tfoot>
              <tr style={{ borderTop: '2px solid ' + BRAND.border, fontWeight: 700 }}>
                <td style={{ textAlign: 'left', padding: '10px 8px' }}>Total {view.periodLabel}</td>
                <td style={{ textAlign: 'right', padding: '10px 8px' }}>{formatGBP(view.totals.net)}</td>
                <td style={{ textAlign: 'right', padding: '10px 8px', color: VAT_COLOR }}>{formatGBP(view.totals.vat)}</td>
                <td style={{ textAlign: 'right', padding: '10px 8px' }}>{formatGBP(view.totals.gross)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
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
