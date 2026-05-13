import React, { useEffect, useState, useCallback } from 'react';
import { Plus, FileText, Trash2 } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP } from '../../utils.js';
import { api } from '../../api.js';
import { Card, Empty } from './Card.jsx';
import { AddInvoiceModal } from './AddInvoiceModal.jsx';

const STATUS_LABEL = {
  authorised: 'Issued',
  issued: 'Issued',
  paid: 'Paid',
  void: 'Void',
};
const STATUS_COLOR = {
  authorised: BRAND.muted,
  issued: BRAND.muted,
  paid: '#16A34A',
  void: '#DC2626',
};

export function InvoicesCard({ dealId, proposals }) {
  const { showMsg } = useStore();
  const [rows, setRows] = useState(null);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(() => {
    api.get('/api/crm/invoices?dealId=' + encodeURIComponent(dealId))
      .then(setRows)
      .catch((err) => { showMsg && showMsg(err.message || 'Failed to load invoices', 'error'); setRows([]); });
  }, [dealId, showMsg]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <Card
      title="Invoices"
      count={rows?.length}
      action={(
        <button onClick={() => setAdding(true)} className="btn-ghost"><Plus size={12} /> Add invoice</button>
      )}
    >
      {!rows && <div style={{ padding: '12px 4px', fontSize: 13, color: BRAND.muted }}>Loading…</div>}
      {rows && rows.length === 0 && <Empty text="No invoices yet" />}
      {rows && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map(r => <InvoiceRow key={r.id} row={r} onChanged={reload} />)}
        </div>
      )}

      {adding && (
        <AddInvoiceModal
          dealId={dealId}
          proposals={proposals}
          onClose={() => setAdding(false)}
          onCreated={() => { setAdding(false); reload(); }}
        />
      )}
    </Card>
  );
}

function InvoiceRow({ row, onChanged }) {
  const { showMsg } = useStore();
  const isManual = row.source === 'manual';
  const date = row.issuedAt ? new Date(row.issuedAt).toLocaleDateString('en-GB') : '';
  const statusColor = STATUS_COLOR[row.status] || BRAND.muted;
  const statusLabel = STATUS_LABEL[row.status] || row.status;
  const sourceLabel = isManual ? 'Manual' : 'Xero';

  async function handleDelete() {
    if (!confirm('Delete this invoice?')) return;
    try {
      await api.delete('/api/crm/invoices/' + encodeURIComponent(row.id.slice('manual:'.length)));
      onChanged?.();
    } catch (err) {
      showMsg?.(err.message || 'Failed to delete', 'error');
    }
  }

  function openPdf() {
    if (row.pdfUrl) window.open(row.pdfUrl, '_blank', 'noopener');
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
          {row.amount != null && <span>{formatGBP(row.amount)}</span>}
          {row.invoiceNumber && <span style={{ fontSize: 11, color: BRAND.muted, fontWeight: 500 }}>{row.invoiceNumber}</span>}
          <span style={{ fontSize: 10, color: statusColor, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }}>{statusLabel}</span>
          <span style={{ fontSize: 10, color: BRAND.muted, fontWeight: 500, padding: '2px 6px', background: BRAND.paper, borderRadius: 4 }}>{sourceLabel}</span>
        </div>
        <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {row.proposalTitle && <span>{row.proposalTitle}</span>}
          {date && <span>· {date}</span>}
          {row.filename && <span>· {row.filename}</span>}
        </div>
      </div>
      {row.pdfUrl && (
        <button onClick={openPdf} className="btn-icon" title="View PDF" style={{ padding: 6 }}>
          <FileText size={14} color={BRAND.muted} />
        </button>
      )}
      {isManual && (
        <button onClick={handleDelete} className="btn-icon" title="Delete" style={{ padding: 6 }}>
          <Trash2 size={14} color={BRAND.muted} />
        </button>
      )}
    </div>
  );
}
