import React, { useState } from 'react';
import { BRAND } from '../theme.js';
import { Field } from './ui.jsx';

export function emptyBilling(defaultEmail = '') {
  return {
    companyName: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    postcode: '',
    country: 'United Kingdom',
    vatNumber: '',
    accountsEmail: defaultEmail || '',
  };
}

export function isBillingValid(b) {
  return Boolean(
    b &&
    b.companyName?.trim() &&
    b.addressLine1?.trim() &&
    b.city?.trim() &&
    b.postcode?.trim() &&
    b.accountsEmail?.trim() &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.accountsEmail.trim())
  );
}

export function BillingFields({ value, onChange, title = 'Your billing details', subtitle }) {
  const [touched, setTouched] = useState({});
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  const blur = (k) => () => setTouched(t => ({ ...t, [k]: true }));
  const err = (k, ok) => touched[k] && !ok ? 'Required' : undefined;
  const emailOk = !value.accountsEmail || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.accountsEmail.trim());

  return (
    <div style={{ background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 10, padding: 18, marginBottom: 16 }}>
      <h4 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 700 }}>{title}</h4>
      {subtitle && <p style={{ margin: '0 0 14px', fontSize: 12, color: BRAND.muted, lineHeight: 1.5 }}>{subtitle}</p>}

      <Field label="Company name" error={err('companyName', !!value.companyName?.trim())}>
        <input className="input" value={value.companyName} onChange={set('companyName')} onBlur={blur('companyName')} placeholder="Legal company name (as it should appear on the invoice)" />
      </Field>

      <Field label="Address line 1" error={err('addressLine1', !!value.addressLine1?.trim())}>
        <input className="input" value={value.addressLine1} onChange={set('addressLine1')} onBlur={blur('addressLine1')} />
      </Field>

      <Field label="Address line 2 (optional)">
        <input className="input" value={value.addressLine2} onChange={set('addressLine2')} />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="City" error={err('city', !!value.city?.trim())}>
          <input className="input" value={value.city} onChange={set('city')} onBlur={blur('city')} />
        </Field>
        <Field label="Postcode" error={err('postcode', !!value.postcode?.trim())}>
          <input className="input" value={value.postcode} onChange={set('postcode')} onBlur={blur('postcode')} />
        </Field>
      </div>

      <Field label="Country">
        <input className="input" value={value.country} onChange={set('country')} />
      </Field>

      <Field label="VAT number (optional)">
        <input className="input" value={value.vatNumber} onChange={set('vatNumber')} placeholder="e.g. GB123456789" />
      </Field>

      <Field label="Accounts / billing email" error={err('accountsEmail', emailOk && !!value.accountsEmail?.trim())}>
        <input className="input" type="email" value={value.accountsEmail} onChange={set('accountsEmail')} onBlur={blur('accountsEmail')} placeholder="invoices@yourcompany.com" />
      </Field>
    </div>
  );
}
