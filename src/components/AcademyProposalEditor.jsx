// The Squideo Academy section of the proposal builder: sell an academy
// alongside the project. Pick a plan from the academy platform's price list,
// monthly or annual, an optional set-up fee, and (on a real proposal) which
// academy it is for when the client already has one.
//
// What is stored on the proposal (data.academy) is a snapshot of the plan as
// priced today, so the proposal says the same thing after a price change. When
// the proposal is signed, the CRM records the order: straight onto the named
// academy, or waiting on the Academies page for one to be set up. It is never
// part of the project total; the CRM invoices it separately.
import React, { useEffect, useRef, useState } from 'react';
import { BRAND } from '../theme.js';
import { api } from '../api.js';
import { Field } from './ui.jsx';
import {
  DEFAULT_ACADEMY_DESCRIPTION, academyOffer, allowanceText, money, perHead, priceText, termsText,
} from '../lib/academyOffer.js';

const ACCENT = '#0E7490';

// A money field that commits when it loses focus, so an auto-saving builder
// isn't handed "7", "75" and "750" as three prices.
function PoundsInput({ value, onChange, ...props }) {
  const [raw, setRaw] = useState(value ? String(value) : '');
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setRaw(value ? String(value) : '');
  }, [value]);
  return (
    <input
      type="number"
      inputMode="decimal"
      min="0"
      step="1"
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      onFocus={() => { focused.current = true; }}
      onBlur={() => {
        focused.current = false;
        const n = parseFloat(raw);
        const final = Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
        setRaw(final ? String(final) : '');
        onChange(final);
      }}
      {...props}
    />
  );
}

function Choice({ active, onClick, title, hint, isMobile }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        flex: isMobile ? '1 1 100%' : '1 1 0', minWidth: 0, textAlign: 'left', padding: '10px 12px', borderRadius: 8,
        border: '2px solid ' + (active ? ACCENT : BRAND.border), background: active ? '#ECFEFF' : 'white', cursor: 'pointer',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: active ? ACCENT : BRAND.ink }}>{title}</div>
      <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 2, lineHeight: 1.4 }}>{hint}</div>
    </button>
  );
}

export function AcademyProposalEditor({ value, onChange, isMobile, allowAcademyPick = true }) {
  const academy = value || { enabled: false };
  const [plans, setPlans] = useState(null);
  const [academies, setAcademies] = useState(null);
  const [error, setError] = useState(null);
  const set = (patch) => onChange({ ...academy, ...patch });

  // The price list and the academies come from the academy platform, via the
  // CRM; asked for only once the section is switched on.
  useEffect(() => {
    if (!academy.enabled || plans) return undefined;
    let live = true;
    api.get('/api/crm/academies/plans')
      .then((r) => { if (live) setPlans(r.plans || []); })
      .catch((err) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [academy.enabled, plans]);
  useEffect(() => {
    if (!academy.enabled || !allowAcademyPick || academies) return undefined;
    let live = true;
    api.get('/api/crm/academies/options')
      .then((r) => { if (live) setAcademies(r.academies || []); })
      .catch(() => { if (live) setAcademies([]); });
    return () => { live = false; };
  }, [academy.enabled, allowAcademyPick, academies]);

  const offer = academyOffer({ academy });
  const choosePlan = (p) => set({
    plan: { slug: p.slug, name: p.name, learners: p.learners, monthly: p.monthly, annual: p.annual, extra: p.extra ?? null },
    billingPeriod: academy.billingPeriod || 'monthly',
  });

  return (
    <div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: academy.enabled ? 16 : 0, cursor: 'pointer' }}>
        <input type="checkbox" checked={Boolean(academy.enabled)} onChange={(e) => set({ enabled: e.target.checked })} />
        <span style={{ fontSize: 14, fontWeight: 600 }}>Include a Squideo Academy on this proposal</span>
      </label>
      {!academy.enabled && (
        <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 6 }}>
          A subscription alongside the project, invoiced separately and never in the project total.
        </div>
      )}

      {academy.enabled && (
        <>
          <Field label="Plan">
            {error && !plans && (
              <div role="alert" style={{ fontSize: 12.5, color: '#B91C1C', marginBottom: 8 }}>
                The price list could not be loaded: {error}
                {academy.plan?.name ? ` The proposal keeps ${academy.plan.name} as it was priced.` : ''}
              </div>
            )}
            {!plans && !error && <div style={{ fontSize: 12.5, color: BRAND.muted }}>Loading the price list…</div>}
            {plans && (
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
                {plans.map((p) => (
                  <Choice
                    key={p.slug}
                    isMobile={false}
                    active={academy.plan?.slug === p.slug}
                    onClick={() => choosePlan(p)}
                    title={`${p.name}: ${money(p.monthly / 100)}/mo`}
                    hint={`Up to ${Number(p.learners).toLocaleString('en-GB')} learners${p.extra ? `, then ${perHead(p.extra / 100)} each` : ''}`}
                  />
                ))}
              </div>
            )}
            {plans && academy.plan && !plans.some((p) => p.slug === academy.plan.slug) && (
              <div style={{ fontSize: 12, color: '#B45309', marginTop: 6 }}>
                {academy.plan.name} is no longer on the price list. The proposal keeps it as it was priced.
              </div>
            )}
          </Field>

          <Field label="Billing">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Choice
                isMobile={isMobile}
                active={academy.billingPeriod !== 'annual'}
                onClick={() => set({ billingPeriod: 'monthly' })}
                title="Monthly"
                hint="Cancel any time, no minimum term."
              />
              <Choice
                isMobile={isMobile}
                active={academy.billingPeriod === 'annual'}
                onClick={() => set({ billingPeriod: 'annual' })}
                title="Annual"
                hint="A year up front, two months free."
              />
            </div>
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 2fr', gap: 12 }}>
            <Field label="Set-up fee (ex VAT, optional)">
              <PoundsInput className="input" value={academy.setupFee || 0} onChange={(n) => set({ setupFee: n })} placeholder="None" />
            </Field>
            {allowAcademyPick && (
              <Field label="Which academy">
                <select
                  className="input"
                  value={academy.tenantId || ''}
                  onChange={(e) => {
                    const chosen = (academies || []).find((a) => a.id === e.target.value);
                    set({ tenantId: chosen?.id || null, tenantName: chosen?.name || null });
                  }}
                >
                  <option value="">A new academy: we set it up after signing</option>
                  {academy.tenantId && !(academies || []).some((a) => a.id === academy.tenantId) && (
                    <option value={academy.tenantId}>{academy.tenantName || 'The academy chosen before'}</option>
                  )}
                  {(academies || []).map((a) => <option key={a.id} value={a.id}>{a.name} ({a.subdomain})</option>)}
                </select>
                <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 4 }}>
                  {academy.tenantId
                    ? 'Signing puts this academy on the plan straight away.'
                    : 'After signing it waits on the Academies page until the academy is set up.'}
                </div>
              </Field>
            )}
          </div>

          <Field label="What the client reads about it">
            <textarea
              className="input"
              style={{ minHeight: 60 }}
              value={academy.description || ''}
              placeholder={DEFAULT_ACADEMY_DESCRIPTION}
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>

          {offer && (
            <div style={{ background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 8, padding: '10px 12px', fontSize: 12.5, color: BRAND.ink, lineHeight: 1.55 }}>
              <strong>On the proposal:</strong> {offer.name}, {allowanceText(offer).toLowerCase()}, {priceText(offer)}
              {offer.setupFee > 0 ? `, plus ${money(offer.setupFee)} set-up` : ''}.
              <div style={{ color: BRAND.muted, marginTop: 4 }}>{termsText(offer, { vat: false }).join(' ')}</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
