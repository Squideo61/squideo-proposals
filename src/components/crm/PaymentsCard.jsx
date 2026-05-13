import React, { useEffect, useState, useCallback } from 'react';
import { Plus, ExternalLink, Trash2, FileText } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP } from '../../utils.js';
import { api } from '../../api.js';
import { Card, Empty } from './Card.jsx';
import { AddPaymentModal } from './AddPaymentModal.jsx';

export function PaymentsCard({ dealId, contactId, companyId, proposals, showAddButton }) {
  const { showMsg } = useStore();
  const [rows, setRows] = useState(null);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(() => {
    const params = new URLSearchParams();
    if (dealId)    params.set('dealId', dealId);
    if (contactId) params.set('contactId', contactId);
    if (companyId) params.set('companyId', companyId);
    api.get('/api/crm/payments?' + params.toString())
      .then(setRows)
      .catch((err) => { showMsg && showMsg(err.message || 'Failed to load payments', 'error'); setRows([]); });
  }, [dealId, contactId, companyId, showMsg]);

  useEffect(() => { reload(); }, [reload]);

  const total = (rows || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);

  return (
    <Card
      title="Payments"
      count={rows?.length}
      action={showAddButton ? (
        <button onClick={() => setAdding(true)} className="btn-ghost"><Plus size={12} /> Add payment</button>
      ) : null}
    >
      {!rows && <div style={{ padding: '12px 4px', fontSize: 13, color: BRAND.muted }}>Loading…</div>}
      {rows && rows.length === 0 && <Empty text="No payments yet" />}
      {rows && rows.length > 0 && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {rows.map(r => (
              <PaymentRow key={r.id} row={r} onChanged={reload} />
            ))}
          </div>
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid ' + BRAND.border, display: 'flex', justifyContent: 'space-between', fontSize: 12, color: BRAND.muted }}>
            <span>Total paid</span>
            <span style={{ fontWeight: 600, color: BRAND.ink }}>{formatGBP(total)}</span>
          </div>
        </>
      )}

      {adding && (
        <AddPaymentModal
          dealId={dealId}
          proposals={proposals}
          onClose={() => setAdding(false)}
          onCreated={() => { setAdding(false); reload(); }}
        />
      )}
    </Card>
  );
}

function PaymentRow({ row, onChanged }) {
  const { showMsg } = useStore();
  const isManual = row.source === 'manual';
  const methodLabel = methodPretty(row);
  const typeLabel = typePretty(row);
  const date = row.paidAt ? new Date(row.paidAt).toLocaleDateString('en-GB') : '';

  async function handleDelete() {
    if (!confirm('Delete this payment record?')) return;
    try {
      await api.delete('/api/crm/payments/' + encodeURIComponent(row.id.slice('manual:'.length)));
      onChanged?.();
    } catch (err) {
      showMsg?.(err.message || 'Failed to delete', 'error');
    }
  }

  function openInvoice() {
    if (row.xeroInvoiceId) {
      window.open('/api/xero/invoice-pdf?invoiceId=' + encodeURIComponent(row.xeroInvoiceId), '_blank', 'noopener');
    } else if (row.receiptUrl) {
      window.open(row.receiptUrl, '_blank', 'noopener');
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
          <span>{formatGBP(row.amount)}</span>
          <span style={{ fontSize: 11, color: BRAND.muted, fontWeight: 500, padding: '2px 6px', background: BRAND.paper, borderRadius: 4 }}>{methodLabel}</span>
          {typeLabel && <span style={{ fontSize: 11, color: BRAND.muted }}>{typeLabel}</span>}
        </div>
        <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {row.proposalTitle && <span>{row.proposalTitle}</span>}
          {date && <span>· {date}</span>}
          {row.notes && <span title={row.notes}>· {truncate(row.notes, 40)}</span>}
        </div>
      </div>
      {(row.xeroInvoiceId || row.receiptUrl) && (
        <button onClick={openInvoice} className="btn-icon" title="Open invoice / receipt" style={{ padding: 6 }}>
          <FileText size={14} color={BRAND.muted} />
        </button>
      )}
      {row.manualInvoiceId && (
        <span title="Linked manual invoice" style={{ fontSize: 11, color: BRAND.muted }}>📎</span>
      )}
      {isManual && (
        <button onClick={handleDelete} className="btn-icon" title="Delete" style={{ padding: 6 }}>
          <Trash2 size={14} color={BRAND.muted} />
        </button>
      )}
    </div>
  );
}

function methodPretty(row) {
  if (row.source === 'stripe' || row.source === 'partner') return 'Stripe';
  const m = (row.paymentMethod || '').toLowerCase();
  if (m === 'bacs') return 'BACS';
  if (m === 'cheque') return 'Cheque';
  if (m === 'cash') return 'Cash';
  return m ? m.toUpperCase() : 'Manual';
}

function typePretty(row) {
  const t = row.paymentType || '';
  if (t === 'deposit') return '50% deposit';
  if (t === 'full') return 'Full payment';
  if (t === 'partial') return 'Partial';
  if (t.startsWith('partner_month_')) return 'Partner month ' + t.slice('partner_month_'.length);
  return t;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
