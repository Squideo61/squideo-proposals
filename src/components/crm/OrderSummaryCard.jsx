import React, { useEffect, useState, useCallback } from 'react';
import { BRAND } from '../../theme.js';
import { formatGBP } from '../../utils.js';
import { api } from '../../api.js';
import { Card, Empty } from './Card.jsx';

// The deal's full order, itemised from the signed proposal exactly like an
// invoice (base + selected extras + discount), with any ad-hoc "extras" added
// during production appended and tagged. refreshKey lets the parent re-pull
// after an extra is added/removed elsewhere on the page.
export function OrderSummaryCard({ dealId, refreshKey }) {
  const [data, setData] = useState(null);
  const [extras, setExtras] = useState(null);

  const load = useCallback(() => {
    api.get('/api/crm/invoices/order-summary?dealId=' + encodeURIComponent(dealId))
      .then(setData)
      .catch(() => setData({ lineItems: [], proposalNumber: null, vatRatePercent: 0 }));
    api.get('/api/crm/extras?dealId=' + encodeURIComponent(dealId))
      .then(setExtras)
      .catch(() => setExtras([]));
  }, [dealId]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const loading = data === null || extras === null;
  const vatPct = data?.vatRatePercent || 0;

  // Proposal lines, then unpaid extras as their own lines.
  const proposalLines = (data?.lineItems || []).map((l) => ({
    description: l.description,
    quantity: Number(l.quantity) || 1,
    unitAmount: Number(l.unitAmount) || 0,
    vatRate: Number(l.vatRate) || 0,
    discountRate: Number(l.discountRate) || 0,
    isExtra: false,
  }));
  const extraLines = (extras || [])
    .filter((e) => e.status !== 'paid')
    .map((e) => ({
      description: e.description,
      quantity: 1,
      unitAmount: Number(e.amount) || 0,
      vatRate: e.vatRate != null ? Number(e.vatRate) * 100 : vatPct,
      discountRate: 0,
      isExtra: true,
    }));
  const lines = [...proposalLines, ...extraLines];

  const lineNet = (l) => l.quantity * l.unitAmount * (1 - (l.discountRate || 0) / 100);
  const subtotal = lines.reduce((s, l) => s + lineNet(l), 0);
  const vat = lines.reduce((s, l) => s + lineNet(l) * (l.vatRate / 100), 0);
  const total = subtotal + vat;

  return (
    <Card title="Order Summary" count={lines.length || undefined}>
      {loading && <div style={{ padding: '12px 4px', fontSize: 13, color: BRAND.muted }}>Loading…</div>}

      {!loading && lines.length === 0 && (
        <Empty text="No order yet — itemises once a proposal is signed" />
      )}

      {!loading && lines.length > 0 && (
        <div>
          {data?.proposalNumber && (
            <div style={{ fontSize: 11, color: BRAND.muted, marginBottom: 8 }}>{data.proposalNumber}</div>
          )}

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px 6px', fontSize: 11, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: '1px solid ' + BRAND.border }}>
            <span style={{ flex: 1 }}>Description</span>
            <span style={{ width: 36, textAlign: 'right' }}>Qty</span>
            <span style={{ width: 90, textAlign: 'right' }}>Unit</span>
            <span style={{ width: 90, textAlign: 'right' }}>Amount</span>
          </div>

          {lines.map((l, i) => {
            const net = lineNet(l);
            const free = l.discountRate >= 100 || net <= 0.005;
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 2px', borderBottom: '1px solid ' + BRAND.paper, fontSize: 13 }}>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {l.isExtra && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#C2410C', background: '#FFF7ED', padding: '1px 6px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, flexShrink: 0 }}>Extra</span>
                  )}
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.description}</span>
                </span>
                <span style={{ width: 36, textAlign: 'right', color: BRAND.muted }}>{l.quantity}</span>
                <span style={{ width: 90, textAlign: 'right', color: BRAND.muted }}>{formatGBP(l.unitAmount)}</span>
                <span style={{ width: 90, textAlign: 'right', fontWeight: 600 }}>{free ? 'Free' : formatGBP(net)}</span>
              </div>
            );
          })}

          {/* Totals */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10, fontSize: 13 }}>
            <Total label="Subtotal (ex VAT)" value={formatGBP(subtotal)} />
            {vat > 0.005 && <Total label={`VAT (${vatPct}%)`} value={formatGBP(vat)} />}
            <Total label="Total" value={formatGBP(total)} strong />
          </div>
        </div>
      )}
    </Card>
  );
}

function Total({ label, value, strong }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: strong ? BRAND.ink : BRAND.muted, fontWeight: strong ? 700 : 500 }}>{label}</span>
      <span style={{ color: BRAND.ink, fontWeight: strong ? 700 : 600 }}>{value}</span>
    </div>
  );
}
