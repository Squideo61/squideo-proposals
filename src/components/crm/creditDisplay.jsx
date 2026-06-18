import React from 'react';
import { BRAND } from '../../theme.js';

// Shared formatting + usage-bar visuals for credit/money allocations. Used by
// the deal-page "Credit Based Projects" (RetainersCard) and the read-only
// company-page "Current Projects" (CompanyCreditsCard) so both stay identical.

export function fmtMoney(n) {
  return '£' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtCredits(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

// allocationType is 'money' or 'credits'.
export function fmtValue(allocationType, n) {
  return allocationType === 'money'
    ? fmtMoney(n)
    : fmtCredits(n) + ' credits';
}

export function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Derived bar figures shared by the bar and the header "remaining" badge.
export function creditBarMeta(total, used) {
  const t = Number(total) || 0;
  const u = Number(used) || 0;
  const remaining = t - u;
  const pct = t > 0 ? Math.min(100, (u / t) * 100) : 0;
  const barColor = pct >= 90 ? '#DC2626' : pct >= 70 ? '#D97706' : '#16A34A';
  const remainingColor = remaining < 0 ? '#DC2626' : remaining === 0 ? BRAND.muted : '#16A34A';
  return { total: t, used: u, remaining, pct, barColor, remainingColor };
}

// Used X of Y · % used · remaining/over-budget — the progress block shown under
// each project header.
export function CreditUsageBar({ allocationType, total, used }) {
  const { remaining, pct, barColor, remainingColor } = creditBarMeta(total, used);
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: BRAND.muted, marginBottom: 4 }}>
        <span>Used: <strong style={{ color: BRAND.ink }}>{fmtValue(allocationType, used)}</strong></span>
        <span>of <strong style={{ color: BRAND.ink }}>{fmtValue(allocationType, total)}</strong></span>
      </div>
      <div style={{ background: BRAND.border, borderRadius: 4, height: 6, overflow: 'hidden' }}>
        <div style={{ background: barColor, height: 6, width: Math.min(100, pct) + '%', borderRadius: 4, transition: 'width 0.3s' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 11 }}>
        <span style={{ color: BRAND.muted }}>{Math.round(pct)}% used</span>
        <span style={{ fontWeight: 600, color: remainingColor }}>
          {remaining >= 0 ? fmtValue(allocationType, remaining) + ' remaining' : fmtValue(allocationType, Math.abs(remaining)) + ' over budget'}
        </span>
      </div>
    </div>
  );
}
