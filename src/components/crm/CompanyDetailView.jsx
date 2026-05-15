import React, { useEffect, useState } from 'react';
import { ArrowLeft, Award, Building2, CheckCircle2, Circle, Globe, User, Edit2, Link2, X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile, formatGBP, formatRelativeTime } from '../../utils.js';
import { api } from '../../api.js';
import { Card, Empty } from './Card.jsx';
import { PaymentsCard } from './PaymentsCard.jsx';
import { PIPELINE_STAGES } from './PipelineView.jsx';
import { XeroContactPicker } from './XeroContactPicker.jsx';

export function CompanyDetailView({ companyId, onBack, onOpenDeal, onOpenContact, onEdit }) {
  const { actions, showMsg } = useStore();
  const isMobile = useIsMobile();
  const [detail, setDetail] = useState(null);
  const [linking, setLinking] = useState(false);
  const [xeroContact, setXeroContact] = useState(null);

  const reload = () => api.get('/api/crm/companies/' + encodeURIComponent(companyId) + '/detail').then(setDetail);

  useEffect(() => {
    if (!companyId) return;
    api.get('/api/crm/companies/' + encodeURIComponent(companyId) + '/detail')
      .then(setDetail)
      .catch((err) => showMsg?.(err.message || 'Failed to load company', 'error'));
  }, [companyId, showMsg]);

  async function handleSaveLink() {
    if (!xeroContact) return;
    try {
      await api.patch('/api/crm/companies/' + encodeURIComponent(companyId), { xeroContactId: xeroContact.id });
      showMsg?.(`Linked to Xero: ${xeroContact.name}`, 'success');
      setLinking(false);
      setXeroContact(null);
      reload();
    } catch (err) {
      showMsg?.(err.message || 'Failed to link', 'error');
    }
  }

  async function handleUnlink() {
    if (!confirm('Unlink this company from its Xero contact?')) return;
    try {
      await api.patch('/api/crm/companies/' + encodeURIComponent(companyId), { xeroContactId: null });
      showMsg?.('Unlinked', 'success');
      reload();
    } catch (err) {
      showMsg?.(err.message || 'Failed to unlink', 'error');
    }
  }

  async function toggleCustomer() {
    if (!detail) return;
    const next = !detail.customerVerifiedAt;
    try {
      await actions.setCompanyCustomerVerified(companyId, next);
      showMsg?.(next ? 'Marked as customer' : 'Customer flag removed', 'success');
      reload();
    } catch (err) {
      showMsg?.(err?.message || 'Could not update customer status', 'error');
    }
  }

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
        <h1 style={{ margin: '0 0 12px', fontSize: 22, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Building2 size={22} color={BRAND.blue} />
          <span>{detail.name}</span>
          {detail.customerVerifiedAt && (
            <span title={'Verified by ' + (detail.customerVerifiedBy || 'admin')} style={{ background: '#DCFCE7', color: '#15803D', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.4, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Award size={11} /> Customer
            </span>
          )}
          {!detail.customerVerifiedAt && detail.hasSignedProposal && (
            <span title="Has at least one signed proposal" style={{ background: '#DBEAFE', color: '#1E40AF', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              Signed customer
            </span>
          )}
        </h1>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, 1fr)', gap: 16 }}>
          <Field icon={Globe} label="Domain">{detail.domain || <span style={{ color: BRAND.muted }}>—</span>}</Field>
          <Field label="Contacts">{detail.contacts.length}</Field>
        </div>

        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid ' + BRAND.border }}>
          <div style={{ fontSize: 11, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
            Customer status
          </div>
          <button onClick={toggleCustomer} className="btn-ghost" style={{ fontSize: 13 }}>
            {detail.customerVerifiedAt
              ? <><CheckCircle2 size={14} color="#16A34A" /> Verified customer — unmark</>
              : detail.hasSignedProposal
              ? <><Circle size={14} /> Auto-flagged via a signed proposal — verify manually</>
              : <><Circle size={14} /> Mark as customer</>}
          </button>
        </div>

        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid ' + BRAND.border }}>
          <div style={{ fontSize: 11, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
            Xero contact link
          </div>
          {detail.xeroContactId ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 6 }}>
              <Link2 size={14} color="#16A34A" />
              <code style={{ fontSize: 12, color: BRAND.ink, flex: 1 }}>{detail.xeroContactId}</code>
              <button onClick={handleUnlink} className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }}>
                <X size={11} /> Unlink
              </button>
            </div>
          ) : linking ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <XeroContactPicker value={xeroContact} onChange={setXeroContact} placeholder={`Search Xero for "${detail.name}"…`} autoFocus />
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button onClick={() => { setLinking(false); setXeroContact(null); }} className="btn-ghost">Cancel</button>
                <button onClick={handleSaveLink} className="btn" disabled={!xeroContact}>Link</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setLinking(true)} className="btn-ghost" style={{ fontSize: 12 }}>
              <Link2 size={12} /> Link to a Xero contact
            </button>
          )}
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
