// One academy in full, for the Academies page (in a window) and the company
// page (in its card): plan and what it is worth, usage against the allowance,
// the trial or renewal date, what needs attention, what is due to invoice and
// the invoices already raised.
import React from 'react';
import { Building2, ExternalLink, Link2, Receipt } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { formatGBP } from '../../utils.js';
import {
  CmsLink, FlagChips, InvoiceLine, datesText, penceGBP, planText, usageText, valueText,
} from './academyUi.jsx';

const FACT = { fontSize: 11.5, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 };

function Fact({ label, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={FACT}>{label}</div>
      <div style={{ fontSize: 13.5, color: BRAND.ink, marginTop: 2 }}>{children || '—'}</div>
    </div>
  );
}

export function AcademyPanel({ academy: a, canInvoice, canLink, onInvoice, onLink, onUnmark, onOpenCompany, showCompany = true }) {
  const s = a.summary || {};
  const over = s.check?.status === 'over';
  const current = s.extra?.current;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 15, color: BRAND.ink }}>{a.name}</strong>
        {a.url && (
          <a href={a.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12.5 }}>
            {a.url.replace(/^https?:\/\//, '')} <ExternalLink size={11} style={{ verticalAlign: -1 }} />
          </a>
        )}
        {a.demo && <span style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, border: '1px solid ' + BRAND.border, borderRadius: 999, padding: '1px 7px' }}>DEMO</span>}
        <span style={{ flex: 1 }} />
        <CmsLink academy={a} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <Fact label="Plan">{planText(a)}</Fact>
        <Fact label="Worth">{valueText(a)}</Fact>
        <Fact label="Active learners this month">
          <span style={{ color: over ? '#B91C1C' : BRAND.ink, fontWeight: over ? 600 : 400 }}>{usageText(a)}</span>
        </Fact>
        <Fact label="Three-month average">{s.usage?.average ?? '—'}</Fact>
        <Fact label={s.trial?.phase && s.trial.phase !== 'none' ? 'Trial' : 'Renewal'}>{datesText(a)}</Fact>
        {showCompany && (
          <Fact label="Company">
            {a.company ? (
              a.company.missing ? <span style={{ color: '#B91C1C' }}>Linked company no longer in the CRM</span> : (
                onOpenCompany
                  ? <button className="btn-ghost" style={{ padding: 0, fontSize: 13.5 }} onClick={() => onOpenCompany(a.company.id)}><Building2 size={12} style={{ verticalAlign: -1, marginRight: 4 }} />{a.company.name}</button>
                  : a.company.name
              )
            ) : 'Not linked'}
          </Fact>
        )}
      </div>

      {s.check?.suggested && (
        <p style={{ margin: 0, fontSize: 13, color: BRAND.ink }}>
          Sized on its three-month average, it fits <strong>{s.check.suggested.name}</strong>.
        </p>
      )}
      {s.request && (
        <p style={{ margin: 0, fontSize: 13, color: '#1D4ED8' }}>
          Asked for {s.request.plan?.name}{s.request.billingPeriod ? `, billed ${s.request.billingPeriod}` : ''}
          {s.request.byName ? ` (${s.request.byName})` : ''}. Set it up in the staff CMS.
        </p>
      )}

      <FlagChips flags={a.flags} />

      {(a.due || []).length > 0 && (
        <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 10, padding: '10px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <strong style={{ fontSize: 13 }}>To invoice</strong>
            <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>{formatGBP(a.dueTotal)} + VAT</span>
            <span style={{ flex: 1 }} />
            {canInvoice && a.company && !a.company.missing && (
              <button className="btn" style={{ fontSize: 12.5 }} onClick={() => onInvoice(a)}>
                <Receipt size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Raise invoice
              </button>
            )}
          </div>
          {a.due.map((l) => (
            <div key={l.periodKey} style={{ display: 'flex', gap: 8, fontSize: 13, padding: '3px 0' }}>
              <span style={{ flex: 1 }}>{l.label}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatGBP(l.amount)}</span>
            </div>
          ))}
          {!a.company && (
            <p style={{ margin: '6px 0 0', fontSize: 12.5, color: BRAND.muted }}>Link it to a company to invoice it.</p>
          )}
        </div>
      )}

      {current && current.months?.some((m) => m.over > 0) && (
        <p style={{ margin: 0, fontSize: 13, color: BRAND.muted }}>
          Extra people so far in {current.label}: {penceGBP(current.total)}. They are invoiced once the period ends.
        </p>
      )}

      {(a.invoices || []).length > 0 && (
        <div>
          <div style={{ ...FACT, marginBottom: 4 }}>Invoiced</div>
          {a.invoices.slice(0, 12).map((row) => (
            <InvoiceLine key={row.id} row={row} canInvoice={canInvoice} onUnmark={onUnmark ? (r) => onUnmark(r, a) : null} />
          ))}
        </div>
      )}

      {canLink && onLink && (
        <div>
          <button className="btn-ghost" style={{ fontSize: 12.5 }} onClick={() => onLink(a)}>
            <Link2 size={13} style={{ verticalAlign: -2, marginRight: 4 }} />{a.company ? 'Change company' : 'Link to a company'}
          </button>
        </div>
      )}
    </div>
  );
}
