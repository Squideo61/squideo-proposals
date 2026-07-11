// "Client portal" card on the deal page: manage the discounted extras offers
// the client sees in their portal (derived from the proposal, plus custom
// upsells), tune the per-deal discount, and resend the portal welcome invite.
// Backed by /api/crm/portal-admin.
import React, { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, Plus, Send, Sparkles, Trash2 } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { formatGBP } from '../../utils.js';
import { Card, Empty } from './Card.jsx';
import { Modal } from '../ui.jsx';

export function PortalDealCard({ dealId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [showCustom, setShowCustom] = useState(false);
  const [custom, setCustom] = useState({ title: '', description: '', amount: '' });
  const [discountEdit, setDiscountEdit] = useState(null); // % string while editing

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/api/crm/portal-admin?dealId=${encodeURIComponent(dealId)}`));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [dealId]);

  useEffect(() => { load(); }, [load]);

  const flash = (msg) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3000);
  };

  const run = async (fn, okMsg) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) flash(okMsg);
      await load();
    } catch (err) {
      flash(err.message);
    } finally {
      setBusy(false);
    }
  };

  const resendWelcome = () => run(
    () => api.post('/api/crm/portal-admin?op=resend-welcome', { dealId }),
    'Portal invite sent'
  );

  const saveDiscount = () => {
    const pct = Number(discountEdit);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return flash('Enter a percentage between 0 and 100');
    run(() => api.post('/api/crm/portal-admin?op=set-discount', { dealId, discount: pct / 100 }), 'Discount updated')
      .then(() => setDiscountEdit(null));
  };

  // Hide/show a proposal-derived offer: an 'override' row with hidden toggled.
  const toggleDerived = (offer) => {
    const extraId = offer.key.startsWith('prop:') ? offer.key.slice(5).split(':')[0] : null;
    if (!extraId) return;
    const existing = (data?.offers || []).find((o) => o.kind === 'override' && o.proposalExtraId === extraId);
    if (existing) {
      run(() => api.post('/api/crm/portal-admin?op=offer-update', { id: existing.id, hidden: !existing.hidden }));
    } else {
      run(() => api.post('/api/crm/portal-admin?op=offer-create', { dealId, kind: 'override', proposalExtraId: extraId, hidden: true }));
    }
  };

  const addCustom = (e) => {
    e.preventDefault();
    run(
      () => api.post('/api/crm/portal-admin?op=offer-create', {
        dealId, kind: 'custom',
        title: custom.title, description: custom.description || null, amount: Number(custom.amount),
      }),
      'Custom offer added'
    ).then(() => { setShowCustom(false); setCustom({ title: '', description: '', amount: '' }); });
  };

  const derived = data?.derived || [];
  const customOffers = (data?.offers || []).filter((o) => o.kind === 'custom');
  const hiddenIds = new Set((data?.offers || []).filter((o) => o.kind === 'override' && o.hidden).map((o) => o.proposalExtraId));
  const discountPct = Math.round((data?.discount ?? 0.10) * 100);

  return (
    <Card
      title={<><Sparkles size={12} style={{ verticalAlign: -1, marginRight: 5 }} />Client portal</>}
      action={
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn-ghost" style={{ fontSize: 12 }} disabled={busy} onClick={resendWelcome} title="Send (or resend) the portal sign-up invite to the signer / primary contact">
            <Send size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Portal invite
          </button>
          <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowCustom(true)}>
            <Plus size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Custom offer
          </button>
        </div>
      }
    >
      {notice && (
        <div style={{ fontSize: 12, color: '#0B6E93', background: '#EAF7FC', border: '1px solid #A9E1F5', borderRadius: 6, padding: '6px 10px', marginBottom: 10 }}>
          {notice}
        </div>
      )}
      {error && <Empty text={error} />}
      {!error && !data && <Empty text="Loading…" />}

      {data && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: BRAND.muted, marginBottom: 12 }}>
            <span>Portal extras discount:</span>
            {discountEdit == null ? (
              <button className="btn-link" style={{ fontSize: 12.5, fontWeight: 700 }} onClick={() => setDiscountEdit(String(discountPct))}>
                {discountPct}% — edit
              </button>
            ) : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input className="input" value={discountEdit} onChange={(e) => setDiscountEdit(e.target.value)} style={{ width: 56, fontSize: 12.5, padding: '3px 6px' }} />%
                <button className="btn" style={{ fontSize: 11.5, padding: '3px 10px' }} disabled={busy} onClick={saveDiscount}>Save</button>
                <button className="btn-ghost" style={{ fontSize: 11.5 }} onClick={() => setDiscountEdit(null)}>Cancel</button>
              </span>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 11.5 }}>Prices follow the proposal — edits there update these offers.</span>
          </div>

          {derived.length === 0 && customOffers.length === 0 && (
            <Empty text="No portal extras to offer — the signed proposal has no remaining optional extras. Add a custom offer to upsell." />
          )}

          {derived.map((o) => {
            const extraId = o.key.startsWith('prop:') ? o.key.slice(5).split(':')[0] : null;
            const isHidden = hiddenIds.has(extraId);
            return (
              <div key={o.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid ' + BRAND.border, fontSize: 13, opacity: isHidden ? 0.5 : 1 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, color: BRAND.ink }}>{o.title}</span>
                  {o.kind === 'custom' && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#7C3AED' }}>CUSTOM</span>}
                </div>
                {o.originalAmount != null && o.originalAmount !== o.amount && (
                  <span style={{ color: BRAND.muted, textDecoration: 'line-through', fontSize: 12 }}>{formatGBP(o.originalAmount)}</span>
                )}
                <span style={{ fontWeight: 700 }}>{formatGBP(o.amount)}</span>
                {o.kind === 'proposal' && (
                  <button className="btn-ghost" disabled={busy} style={{ fontSize: 11.5, padding: 4 }} title={isHidden ? 'Show in portal' : 'Hide from portal'} onClick={() => toggleDerived(o)}>
                    {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                )}
              </div>
            );
          })}

          {customOffers.map((o) => (
            <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid ' + BRAND.border, fontSize: 13, opacity: o.hidden ? 0.5 : 1 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: BRAND.ink }}>{o.title}</span>
                <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#7C3AED' }}>CUSTOM</span>
                {o.description && <div style={{ fontSize: 11.5, color: BRAND.muted }}>{o.description}</div>}
              </div>
              <span style={{ fontWeight: 700 }}>{formatGBP(o.amount)}</span>
              <button className="btn-ghost" disabled={busy} style={{ fontSize: 11.5, padding: 4 }} title={o.hidden ? 'Show in portal' : 'Hide from portal'}
                onClick={() => run(() => api.post('/api/crm/portal-admin?op=offer-update', { id: o.id, hidden: !o.hidden }))}>
                {o.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
              <button className="btn-ghost is-danger" disabled={busy} style={{ fontSize: 11.5, padding: 4 }} title="Delete offer"
                onClick={() => run(() => api.post('/api/crm/portal-admin?op=offer-delete', { id: o.id }), 'Offer deleted')}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </>
      )}

      {showCustom && (
        <Modal onClose={() => setShowCustom(false)} maxWidth={420}>
          <h3 style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 700 }}>Custom portal offer</h3>
          <form onSubmit={addCustom} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input className="input" required placeholder="Title — e.g. Vertical cutdown for socials" value={custom.title} onChange={(e) => setCustom((c) => ({ ...c, title: e.target.value }))} />
            <textarea className="input" rows={2} placeholder="Description shown to the client (optional)" value={custom.description} onChange={(e) => setCustom((c) => ({ ...c, description: e.target.value }))} />
            <input className="input" required type="number" min="1" step="0.01" placeholder="Price ex VAT (£) — shown as-is, no further discount" value={custom.amount} onChange={(e) => setCustom((c) => ({ ...c, amount: e.target.value }))} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn-ghost" onClick={() => setShowCustom(false)}>Cancel</button>
              <button className="btn" type="submit" disabled={busy}>Add offer</button>
            </div>
          </form>
        </Modal>
      )}
    </Card>
  );
}
