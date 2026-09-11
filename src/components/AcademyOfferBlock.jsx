// A Squideo Academy on the client's proposal: the plan, what it costs, the
// terms, and plainly that signing the proposal includes it. It is invoiced
// separately, so it sits outside the project total and the payment options.
import React from 'react';
import { GraduationCap } from 'lucide-react';
import { BRAND } from '../theme.js';
import { DEFAULT_ACADEMY_DESCRIPTION, money, priceText, termsText } from '../lib/academyOffer.js';

const TINT = '#E6F7FD';

function Fact({ label, value, sub }) {
  return (
    <div style={{ background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 10, padding: '10px 12px', minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: BRAND.muted }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: BRAND.ink, marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export function AcademyOfferBlock({ offer: o, showVat, signed, isMobile }) {
  const vat = showVat ? ' + VAT' : '';
  return (
    <section
      aria-label="Squideo Academy"
      style={{ border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 14 : 20, marginBottom: 28, background: 'white' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <span style={{ width: 42, height: 42, borderRadius: 10, background: TINT, color: BRAND.blue, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <GraduationCap size={22} aria-hidden="true" />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: BRAND.ink }}>Squideo Academy: {o.name} plan</div>
          <div style={{ fontSize: 13, color: BRAND.muted }}>
            {signed ? 'Part of your signed agreement' : 'Included when you sign this proposal'}
          </div>
        </div>
      </div>

      <p style={{ margin: '0 0 14px', fontSize: 14, lineHeight: 1.6, color: BRAND.ink, whiteSpace: 'pre-wrap' }}>
        {o.description || DEFAULT_ACADEMY_DESCRIPTION}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : `repeat(${o.setupFee > 0 ? 3 : 2}, minmax(0, 1fr))`, gap: 10, marginBottom: 14 }}>
        <Fact
          label="Active learners"
          value={o.learners ? `Up to ${o.learners.toLocaleString('en-GB')} a month` : 'As agreed'}
          sub={o.freeOver ? `+${o.freeOver} free in a busy month` : null}
        />
        <Fact
          label={o.annual ? 'Paid yearly' : 'Paid monthly'}
          value={`${priceText(o)}${vat}`}
          sub={o.annual ? `Instead of ${money(o.monthly * 12)} paid monthly` : 'Cancel any time'}
        />
        {o.setupFee > 0 && <Fact label="One-off set-up" value={`${money(o.setupFee)}${vat}`} sub="Invoiced once your academy is set up" />}
      </div>

      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: BRAND.muted, display: 'grid', gap: 2 }}>
        {termsText(o, { vat: showVat }).map((t) => <li key={t}>{t}</li>)}
      </ul>
    </section>
  );
}
