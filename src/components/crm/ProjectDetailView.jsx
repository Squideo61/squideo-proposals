import React, { useEffect } from 'react';
import { ArrowLeft, Building2, User, ExternalLink } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, useIsMobile } from '../../utils.js';
import { ProductionPanel } from './ProductionPanel.jsx';

// Focused project page opened from the production board. Unlike the full deal
// page (sales pipeline, proposals, emails…), this shows just the production
// essentials — customer, the Production controls, and the videos — with an
// "Open full deal" escape hatch back to the CRM record.
export function ProjectDetailView({ dealId, onBack, onOpenFullDeal, onOpenVideo }) {
  const { state, actions } = useStore();
  const isMobile = useIsMobile();

  useEffect(() => { if (dealId) actions.loadDealDetail(dealId); }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  const detail = state.dealDetail[dealId];
  const deal = detail || state.deals[dealId];
  const company = deal?.companyId ? state.companies[deal.companyId] : null;
  const contact = deal?.primaryContactId ? state.contacts[deal.primaryContactId] : null;

  if (!deal) {
    return (
      <div style={{ padding: 32 }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
        <p style={{ marginTop: 24, color: BRAND.muted }}>Loading project…</p>
      </div>
    );
  }

  const muted = <span style={{ color: BRAND.muted }}>—</span>;

  return (
    <div style={{ padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Production</button>
        {onOpenFullDeal && (
          <button onClick={() => onOpenFullDeal(dealId)} className="btn-ghost"><ExternalLink size={14} /> Open full deal</button>
        )}
      </header>

      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 16 : 24, marginBottom: 16 }}>
        <h1 style={{ margin: '0 0 16px', fontSize: 22, fontWeight: 700 }}>{deal.title}</h1>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 16 }}>
          <Field icon={Building2} label="Customer">{company?.name || muted}</Field>
          <Field icon={User} label="Primary contact">
            {contact
              ? <>{contact.name || contact.email}{contact.email && contact.name ? <span style={{ color: BRAND.muted, fontSize: 12 }}> · {contact.email}</span> : null}</>
              : muted}
          </Field>
          <Field label="Value (ex VAT)">{deal.value != null ? <strong>{formatGBP(deal.value)}</strong> : muted}</Field>
        </div>
      </div>

      <ProductionPanel dealId={dealId} deal={deal} videos={detail?.videos || []} isMobile={isMobile} onOpenVideo={onOpenVideo} />
    </div>
  );
}

function Field({ icon: Icon, label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.4, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        {Icon && <Icon size={13} />} {label}
      </div>
      <div style={{ fontSize: 14, color: BRAND.ink }}>{children}</div>
    </div>
  );
}
