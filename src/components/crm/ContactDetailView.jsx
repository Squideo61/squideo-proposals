import React, { useEffect, useState } from 'react';
import { ArrowLeft, Building2, Mail, Phone, User, Edit2 } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile, formatGBP, formatRelativeTime } from '../../utils.js';
import { api } from '../../api.js';
import { Card, Empty } from './Card.jsx';
import { PaymentsCard } from './PaymentsCard.jsx';
import { PIPELINE_STAGES } from './PipelineView.jsx';

export function ContactDetailView({ contactId, onBack, onOpenDeal, onOpenCompany, onEdit }) {
  const { showMsg } = useStore();
  const isMobile = useIsMobile();
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    if (!contactId) return;
    api.get('/api/crm/contacts/' + encodeURIComponent(contactId) + '/detail')
      .then(setDetail)
      .catch((err) => showMsg?.(err.message || 'Failed to load contact', 'error'));
  }, [contactId, showMsg]);

  if (!detail) {
    return (
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: 32 }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
        <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted }}>Loading…</div>
      </div>
    );
  }

  const fullName = detail.name || detail.email || 'Contact';

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Contacts</button>
        <button onClick={() => onEdit?.(detail)} className="btn-ghost"><Edit2 size={14} /> Edit contact</button>
      </header>

      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 16 : 24, marginBottom: 16 }}>
        <h1 style={{ margin: '0 0 12px', fontSize: 22, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10 }}>
          <User size={22} color={BRAND.blue} /> {fullName}
        </h1>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 16 }}>
          <Field icon={Mail} label="Email">{detail.email || <span style={{ color: BRAND.muted }}>—</span>}</Field>
          <Field icon={Phone} label="Phone">{detail.phone || <span style={{ color: BRAND.muted }}>—</span>}</Field>
          <Field label="Title">{detail.title || <span style={{ color: BRAND.muted }}>—</span>}</Field>
          <Field icon={Building2} label="Company">
            {detail.company ? (
              <button
                onClick={() => onOpenCompany?.(detail.company.id)}
                style={{ background: 'none', border: 'none', padding: 0, color: BRAND.blue, cursor: 'pointer', font: 'inherit' }}
              >
                {detail.company.name}
              </button>
            ) : <span style={{ color: BRAND.muted }}>—</span>}
          </Field>
        </div>
        {detail.notes && (
          <div style={{ marginTop: 16, padding: 12, background: '#F8FAFC', borderRadius: 8, fontSize: 13, whiteSpace: 'pre-wrap' }}>
            {detail.notes}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
        <Card title="Deals" count={detail.deals.length}>
          {detail.deals.length === 0 && <Empty text="No deals where this contact is primary" />}
          {detail.deals.map(d => <DealRow key={d.id} deal={d} onOpen={() => onOpenDeal?.(d.id)} />)}
        </Card>

        <PaymentsCard contactId={contactId} />
      </div>
    </div>
  );
}

function Field({ icon: Icon, label, children }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 4 }}>
        {Icon && <Icon size={11} />}
        {label}
      </div>
      <div style={{ fontSize: 14 }}>{children}</div>
    </div>
  );
}

function DealRow({ deal, onOpen }) {
  const stage = PIPELINE_STAGES.find(s => s.id === deal.stage);
  return (
    <button
      onClick={onOpen}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%', padding: '8px 10px', background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', marginBottom: 6 }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{deal.title}</div>
        <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>
          {stage?.label || deal.stage}
          {deal.value != null && <> · {formatGBP(deal.value)}</>}
          {deal.lastActivityAt && <> · {formatRelativeTime(deal.lastActivityAt)}</>}
        </div>
      </div>
    </button>
  );
}
