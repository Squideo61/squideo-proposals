// "Add extras" — the soft-sell page. Offers derive from the client's own
// proposal prices (length-tailored) with the portal discount shown as a
// strike-through; staff-added upsells appear alongside. Accepting adds a
// pending line to the final invoice — nothing to pay now.
import React, { useEffect, useState } from 'react';
import { BRAND } from '../../theme.js';
import { portalApi } from '../api.js';
import { usePortal } from '../PortalContext.jsx';
import { Card, EmptyState, SectionHeading, StatusPill, fmtGBP } from '../components.jsx';
import { ArrowLeft, Sparkles, Check, Minus, Plus } from 'lucide-react';

function OfferCard({ offer, onAccept, busy }) {
  const [qty, setQty] = useState(1);
  const discounted = offer.originalAmount != null && offer.amount < offer.originalAmount;
  return (
    <div style={{
      border: `1px solid ${BRAND.border}`, borderRadius: 14, padding: 18,
      display: 'flex', flexDirection: 'column', gap: 10, background: '#fff',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 14.5, color: BRAND.ink }}>{offer.title}</div>
        {discounted && (
          <span style={{ background: '#16A34A', color: '#fff', borderRadius: 999, padding: '2px 9px', fontSize: 10.5, fontWeight: 800, flexShrink: 0 }}>
            PORTAL PRICE
          </span>
        )}
        {offer.kind === 'custom' && (
          <span style={{ background: '#7C3AED', color: '#fff', borderRadius: 999, padding: '2px 9px', fontSize: 10.5, fontWeight: 800, flexShrink: 0 }}>
            JUST FOR YOU
          </span>
        )}
      </div>
      {offer.description && (
        <div style={{ fontSize: 12.5, color: BRAND.muted, lineHeight: 1.5 }}>{offer.description}</div>
      )}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 19, fontWeight: 800, color: BRAND.ink }}>{fmtGBP(offer.amount * qty)}</span>
        {discounted && (
          <span style={{ fontSize: 13, color: BRAND.muted, textDecoration: 'line-through' }}>
            {fmtGBP(offer.originalAmount * qty)}
          </span>
        )}
        <span style={{ fontSize: 11.5, color: BRAND.muted }}>ex VAT</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
        {offer.hasQuantity && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, border: `1px solid ${BRAND.border}`, borderRadius: 8, padding: '4px 8px' }}>
            <button className="btn-icon" onClick={() => setQty((q) => Math.max(1, q - 1))} style={{ padding: 2 }}><Minus size={13} /></button>
            <span style={{ fontSize: 13, fontWeight: 700, minWidth: 16, textAlign: 'center' }}>{qty}</span>
            <button className="btn-icon" onClick={() => setQty((q) => Math.min(50, q + 1))} style={{ padding: 2 }}><Plus size={13} /></button>
          </div>
        )}
        <button
          className="btn"
          disabled={busy}
          onClick={() => onAccept(offer, qty)}
          style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
        >
          <Sparkles size={14} /> Add to my project
        </button>
      </div>
    </div>
  );
}

export default function Extras({ dealId }) {
  const { showToast, refreshOverview } = usePortal();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [confirming, setConfirming] = useState(null); // { offer, qty }

  const load = async () => {
    try {
      setData(await portalApi.get(`extras?dealId=${encodeURIComponent(dealId)}`));
    } catch (err) {
      setError(err.message);
    }
  };
  useEffect(() => { load(); }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  const accept = async (offer, qty) => {
    setBusyKey(offer.key);
    try {
      await portalApi.post('extras-accept', { dealId, offerKey: offer.key, quantity: qty });
      showToast(`${offer.title} added ✓ — it'll appear on your final invoice`);
      setConfirming(null);
      await load();
      refreshOverview().catch(() => {});
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusyKey(null);
    }
  };

  if (error) {
    return (
      <div>
        <a href="#/" className="btn-link" style={{ fontSize: 13 }}><ArrowLeft size={14} style={{ verticalAlign: -2 }} /> Back</a>
        <Card style={{ marginTop: 14 }}><EmptyState title="Couldn't load extras" body={error} /></Card>
      </div>
    );
  }
  if (!data) return <div style={{ color: BRAND.muted, fontSize: 13, padding: 30, textAlign: 'center' }}>Loading extras…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <a href={`#/project/${dealId}`} className="btn-link" style={{ fontSize: 13 }}>
          <ArrowLeft size={14} style={{ verticalAlign: -2 }} /> {data.dealTitle}
        </a>
        <h1 style={{ margin: '8px 0 4px', fontSize: 22, fontWeight: 800, color: BRAND.ink }}>Add extras ✨</h1>
        <p style={{ margin: 0, fontSize: 13.5, color: BRAND.muted, maxWidth: 560, lineHeight: 1.55 }}>
          Exclusive portal prices on add-ons for this project — priced from your proposal
          {data.discount > 0 ? ` with ${Math.round(data.discount * 100)}% off` : ''}.
          Anything you add simply rides your final invoice; nothing to pay today.
        </p>
      </div>

      {!data.windowOpen ? (
        <Card>
          <EmptyState
            title="Extras aren't available for this project right now"
            body="Extras can be added while a project is live. Fancy something extra anyway? Just message your producer."
          />
        </Card>
      ) : data.offers.length === 0 ? (
        <Card>
          <EmptyState
            title="No extras available just now"
            body="Your producer can add tailored extras here — or just ask if there's something you'd like."
          />
        </Card>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: 14 }}>
          {data.offers.map((o) => (
            <OfferCard key={o.key} offer={o} busy={busyKey === o.key} onAccept={(offer, qty) => setConfirming({ offer, qty })} />
          ))}
        </div>
      )}

      {(data.accepted || []).length > 0 && (
        <Card>
          <SectionHeading>Already added</SectionHeading>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.accepted.map((x) => (
              <div key={x.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                <Check size={14} color="#16A34A" />
                <span style={{ flex: 1, color: BRAND.ink }}>{x.description}</span>
                <span style={{ fontWeight: 700 }}>{fmtGBP(x.amount)}</span>
                <StatusPill
                  label={x.status === 'paid' ? 'Paid' : x.status === 'invoiced' ? 'Invoiced' : 'On final invoice'}
                  color={x.status === 'paid' ? '#16A34A' : x.status === 'invoiced' ? '#0EA5E9' : '#F59E0B'}
                />
              </div>
            ))}
          </div>
        </Card>
      )}

      {confirming && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15,42,61,0.5)', zIndex: 60,
            display: 'grid', placeItems: 'center', padding: 16,
          }}
        >
          <div style={{ background: '#fff', borderRadius: 14, padding: 24, maxWidth: 380, width: '100%' }}>
            <h3 style={{ margin: '0 0 10px', fontSize: 16, fontWeight: 800, color: BRAND.ink }}>Add to your project?</h3>
            <p style={{ margin: '0 0 6px', fontSize: 13.5, color: BRAND.ink }}>
              <strong>{confirming.offer.title}{confirming.qty > 1 ? ` × ${confirming.qty}` : ''}</strong>
              {' — '}{fmtGBP(confirming.offer.amount * confirming.qty)} ex VAT
            </p>
            <p style={{ margin: '0 0 18px', fontSize: 12.5, color: BRAND.muted, lineHeight: 1.5 }}>
              It'll be added to your final invoice and our team will fold it into production. You'll get a confirmation email.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn-ghost" onClick={() => setConfirming(null)}>Cancel</button>
              <button className="btn" disabled={!!busyKey} onClick={() => accept(confirming.offer, confirming.qty)}>
                {busyKey ? 'Adding…' : 'Confirm — add it'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
