import React, { useEffect, useState } from 'react';
import { ArrowLeft, Building2, Globe, User, Edit2 } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile, formatGBP, formatRelativeTime } from '../../utils.js';
import { api } from '../../api.js';
import { Card, Empty } from './Card.jsx';
import { PaymentsCard } from './PaymentsCard.jsx';
import { PIPELINE_STAGES } from './PipelineView.jsx';

export function CompanyDetailView({ companyId, onBack, onOpenDeal, onOpenContact, onEdit }) {
  const { showMsg } = useStore();
  const isMobile = useIsMobile();
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    if (!companyId) return;
    api.get('/api/crm/companies/' + encodeURIComponent(companyId) + '/detail')
      .then(setDetail)
      .catch((err) => showMsg?.(err.message || 'Failed to load company', 'error'));
  }, [companyId, showMsg]);

  if (!detail) {
    return (
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: 32 }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Back</button>
        <div style={{ padding: 40, textAlign: 'center', color: BRAND.muted }}>Loading…</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: isMobile ? '16px 12px' : '32px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <button onClick={onBack} className="btn-ghost"><ArrowLeft size={14} /> Contacts</button>
        <button onClick={() => onEdit?.(detail)} className="btn-ghost"><Edit2 size={14} /> Edit company</button>
      </header>

      <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 12, padding: isMobile ? 16 : 24, marginBottom: 16 }}>
        <h1 style={{ margin: '0 0 12px', fontSize: 22, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Building2 size={22} color={BRAND.blue} /> {detail.name}
        </h1>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, 1fr)', gap: 16 }}>
          <Field icon={Globe} label="Domain">{detail.domain || <span style={{ color: BRAND.muted }}>—</span>}</Field>
          <Field label="Contacts">{detail.contacts.length}</Field>
        </div>
        {detail.notes && (
          <div style={{ marginTop: 16, padding: 12, background: '#F8FAFC', borderRadius: 8, fontSize: 13, whiteSpace: 'pre-wrap' }}>
            {detail.notes}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
        <Card title="Contacts" count={detail.contacts.length}>
          {detail.contacts.length === 0 && <Empty text="No contacts at this company" />}
          {detail.contacts.map(c => (
            <button
              key={c.id}
              onClick={() => onOpenContact?.(c.id)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%', padding: '8px 10px', background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', marginBottom: 6 }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{c.name || c.email || c.id}</div>
                <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>
                  {c.title}{c.title && c.email && ' · '}{c.email}
                </div>
              </div>
              <User size={14} color={BRAND.muted} />
            </button>
          ))}
        </Card>

        <Card title="Deals" count={detail.deals.length}>
          {detail.deals.length === 0 && <Empty text="No deals at this company" />}
          {detail.deals.map(d => {
            const stage = PIPELINE_STAGES.find(s => s.id === d.stage);
            return (
              <button
                key={d.id}
                onClick={() => onOpenDeal?.(d.id)}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%', padding: '8px 10px', background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', marginBottom: 6 }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{d.title}</div>
                  <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>
                    {stage?.label || d.stage}
                    {d.value != null && <> · {formatGBP(d.value)}</>}
                    {d.lastActivityAt && <> · {formatRelativeTime(d.lastActivityAt)}</>}
                  </div>
                </div>
              </button>
            );
          })}
        </Card>

        <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
          <PaymentsCard companyId={companyId} />
        </div>
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
