import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, TrendingUp, Pencil, Check, X } from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, useIsMobile, workingDaysBetween, ukBankHolidays, todayKey } from '../../utils.js';

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

export function PerformanceView({ onBack }) {
  const { state, actions } = useStore();
  const isMobile = useIsMobile();
  const [mode, setMode] = useState('month'); // 'month' | 'quarter'
  const [month, setMonth] = useState(() => todayKey().slice(0, 7));
  const [quarter, setQuarter] = useState(() => recentQuarters(1)[0]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);

  const period = mode === 'month' ? month : quarter;

  useEffect(() => {
    if (!state.bankHolidays) actions.loadBankHolidays();
  }, [actions, state.bankHolidays]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    actions.loadPerformanceStats(period).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [actions, period]);

  const targets = (state.financeTargets && state.financeTargets.length) ? state.financeTargets : FALLBACK_TARGETS;
  const holidays = useMemo(
    () => (Array.isArray(state.bankHolidays) && state.bankHolidays.length ? new Set(state.bankHolidays) : ukBankHolidays),
    [state.bankHolidays],
  );
  const perf = state.performanceStats && state.performanceStats.period === period ? state.performanceStats : null;

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
    <div style={{ padding: isMobile ? '20px 16px' : '40px 24px', maxWidth: 1100, margin: '0 auto' }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <TrendingUp size={22} color={BRAND.blue} />
              <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Performance</h1>
            </div>
            <p style={{ fontSize: 13, color: BRAND.muted, margin: '2px 0 0' }}>
              Cash received (ex-VAT) across all customers, paced against your targets by working day.
            </p>
          </div>
        </div>
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
      </header>

      {editing && <TargetEditor targets={targets} onSave={(list) => { actions.saveFinanceTargets(list); setEditing(false); }} onCancel={() => setEditing(false)} />}

      {/* Pace strip: where you are today vs each target's expected pace. */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : `repeat(${targets.length + 1}, 1fr)`, gap: 12, marginBottom: 16 }}>
        <PaceCard
          title={model.status === 'future' ? 'Upcoming period' : `Working day ${model.lastActualIdx} of ${model.N}`}
          big={formatGBP(model.netSoFar)}
          sub={model.status === 'in_progress'
            ? `Net banked so far · projected ${formatGBP(model.projected)} by end`
            : (model.status === 'complete' ? 'Net banked (final)' : 'No cash yet')}
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

      {/* The Day Performance chart. */}
      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 12 : 20 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          {mode === 'quarter' ? 'Quarter performance' : 'Day Performance'} — {model.label}
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
              <Line type="monotone" dataKey="actual" name="Cash received (net)" stroke={BRAND.blue} strokeWidth={2.75} dot={false} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
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

function PaceCard({ title, big, sub, color, accent }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderLeft: accent ? `3px solid ${accent}` : '1px solid ' + BRAND.border, borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || BRAND.ink }}>{big}</div>
      <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function TargetEditor({ targets, onSave, onCancel }) {
  const [rows, setRows] = useState(() => targets.map((t) => ({ ...t })));
  const set = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: BRAND.ink, marginBottom: 12 }}>Monthly targets</div>
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
