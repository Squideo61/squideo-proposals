// Shared date-range control + model used by the Marketing and Sales Insights
// dashboards: rolling-window presets, a month stepper (this month + previous
// months), and a custom from–to range. A range descriptor is one of:
//   { mode: 'preset', days }
//   { mode: 'month',  month: 'YYYY-MM' }
//   { mode: 'custom', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
import React, { useState } from 'react';
import { BRAND } from '../../theme.js';

export const RANGE_PRESETS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '12 months' },
];

export const dateStr = (d) => d.toISOString().slice(0, 10);
export function rangeFor(days) {
  const now = new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - (days - 1) * 86400000);
  return { from: dateStr(from), to: dateStr(to) };
}
export function thisMonthStr() {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}`;
}
export function shiftMonth(monthStr, delta) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, (m - 1) + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
export function monthRange(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this one
  return { from: dateStr(from), to: dateStr(to) };
}
export function monthLabel(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
// Short heading for the active range, e.g. "June 2026" / "Last 90 days" / "Custom".
export function rangeHeading(range) {
  if (range?.mode === 'month' && range.month) return monthLabel(range.month);
  if (range?.mode === 'custom') return 'Custom range';
  const p = RANGE_PRESETS.find((x) => x.days === range?.days);
  return 'Last ' + (p ? p.label.toLowerCase() : '90 days');
}
// Explicit date span, e.g. "1 – 30 Jun 2026" / "28 May – 26 Jun 2026".
export function fmtRangeDates(fromStr, toStr) {
  if (!fromStr || !toStr) return '';
  const f = new Date(fromStr + 'T00:00:00Z');
  const t = new Date(toStr + 'T00:00:00Z');
  const sameYear = f.getUTCFullYear() === t.getUTCFullYear();
  const sameMonth = sameYear && f.getUTCMonth() === t.getUTCMonth();
  const fOpt = sameMonth ? { day: 'numeric', timeZone: 'UTC' } : { day: 'numeric', month: 'short', timeZone: 'UTC', ...(sameYear ? {} : { year: 'numeric' }) };
  const tOpt = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' };
  return f.toLocaleDateString('en-GB', fOpt) + ' – ' + t.toLocaleDateString('en-GB', tOpt);
}
// Resolve a range descriptor to inclusive { from, to } date strings for the API.
export function computeRange(range) {
  if (range?.mode === 'month' && range.month) return monthRange(range.month);
  if (range?.mode === 'custom' && range.from && range.to) {
    return range.from <= range.to ? { from: range.from, to: range.to } : { from: range.to, to: range.from };
  }
  return rangeFor(range?.days || 90);
}

export const segBtn = (active) => ({
  padding: '5px 12px', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13,
  fontWeight: active ? 600 : 500, color: active ? 'white' : BRAND.ink,
  background: active ? BRAND.blue : 'transparent',
});

// Date-range picker: rolling-window presets, a month stepper (this month +
// previous months via ‹ ›/the month picker), and a custom from–to range.
export function RangeControl({ range, setRange }) {
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
