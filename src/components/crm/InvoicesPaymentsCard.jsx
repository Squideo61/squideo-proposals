import React, { useEffect, useState, useCallback } from 'react';
import { Plus, FileText, Trash2, CheckCircle, Link, Copy, Check, ExternalLink } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, formatCurrency, formatAmountWithGbp } from '../../utils.js';
import { api } from '../../api.js';
import { Card, Empty } from './Card.jsx';
import { AddInvoiceModal } from './AddInvoiceModal.jsx';
import { AddPaymentModal } from './AddPaymentModal.jsx';
import { MarkInvoicePaidModal } from './MarkInvoicePaidModal.jsx';
import { CreateXeroInvoiceModal } from './CreateXeroInvoiceModal.jsx';

const STATUS_LABEL = { authorised: 'Issued', issued: 'Issued', paid: 'Paid', void: 'Void' };
const STATUS_COLOR = {
  authorised: BRAND.muted,
  issued: BRAND.muted,
  paid: '#16A34A',
  void: '#DC2626',
};

export function InvoicesPaymentsCard({ dealId, proposals, contactName }) {
  const { showMsg } = useStore();
  const [invoices, setInvoices] = useState(null);
  const [payments, setPayments] = useState(null);
  const [adding, setAdding] = useState(false);
  const [addingPayment, setAddingPayment] = useState(false);
  const [creatingXero, setCreatingXero] = useState(false);

  const reloadInvoices = useCallback(() => {
    api.get('/api/crm/invoices?dealId=' + encodeURIComponent(dealId))
      .then(setInvoices)
      .catch((err) => { showMsg?.(err.message || 'Failed to load invoices', 'error'); setInvoices([]); });
  }, [dealId, showMsg]);

  const reloadPayments = useCallback(() => {
    api.get('/api/crm/payments?dealId=' + encodeURIComponent(dealId))
      .then(rows => {
        // Only keep manual payments that are not linked to a manual_invoice
        // (linked ones are represented by the invoice's paid status instead).
        setPayments(rows.filter(r => r.source === 'manual' && !r.manualInvoiceId));
      })
      .catch((err) => { showMsg?.(err.message || 'Failed to load payments', 'error'); setPayments([]); });
  }, [dealId, showMsg]);

  const reload = useCallback(() => {
    reloadInvoices();
    reloadPayments();
  }, [reloadInvoices, reloadPayments]);

  useEffect(() => { reload(); }, [reload]);

  const loading = invoices === null || payments === null;
  const allInvoices = invoices || [];
  const standAlonePayments = payments || [];

  // Totals are summed per-currency — we don't FX-convert non-GBP into a single
  // bucket, so each currency renders as its own subtotal.
  const paidRows = [
    ...allInvoices.filter(r => r.status === 'paid'),
    ...standAlonePayments,
  ];
  const totalsByCurrency = paidRows.reduce((acc, r) => {
    const ccy = r.currency || 'GBP';
    acc[ccy] = (acc[ccy] || 0) + (Number(r.amount) || 0);
    return acc;
  }, {});
  const totalEntries = Object.entries(totalsByCurrency).filter(([, v]) => v > 0);

  const count = allInvoices.length + standAlonePayments.length;

  return (
    <Card
      title="Invoices & Payments"
      count={count || undefined}
      action={(
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setCreatingXero(true)} className="btn"><Plus size={12} /> Create invoice</button>
          <button onClick={() => setAdding(true)} className="btn-ghost"><Plus size={12} /> Upload invoice</button>
          <button onClick={() => setAddingPayment(true)} className="btn-ghost"><Plus size={12} /> Add payment</button>
        </div>
      )}
    >
      {loading && <div style={{ padding: '12px 4px', fontSize: 13, color: BRAND.muted }}>Loading…</div>}

      {!loading && count === 0 && <Empty text="No invoices or payments yet" />}

      {!loading && allInvoices.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {allInvoices.map(r => (
            <InvoiceRow key={r.id} row={r} dealId={dealId} onChanged={reload} />
          ))}
        </div>
      )}

      {!loading && standAlonePayments.length > 0 && (
        <>
          {allInvoices.length > 0 && (
            <div style={{ fontSize: 11, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, margin: '14px 0 6px' }}>
              Other payments
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {standAlonePayments.map(r => (
              <StandalonePaymentRow key={r.id} row={r} onChanged={reloadPayments} />
            ))}
          </div>
        </>
      )}

      {!loading && totalEntries.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid ' + BRAND.border, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: BRAND.muted }}>
          {totalEntries.map(([ccy, total]) => (
            <div key={ccy} style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Total paid{totalEntries.length > 1 ? ` (${ccy})` : ''}</span>
              <span style={{ fontWeight: 600, color: BRAND.ink }}>{formatCurrency(total, ccy)}</span>
            </div>
          ))}
        </div>
      )}

      {creatingXero && (
        <CreateXeroInvoiceModal
          dealId={dealId}
          contactName={contactName}
          onClose={() => setCreatingXero(false)}
          onCreated={() => { setCreatingXero(false); reloadInvoices(); }}
        />
      )}
      {adding && (
        <AddInvoiceModal
          dealId={dealId}
          proposals={proposals}
          onClose={() => setAdding(false)}
          onCreated={() => { setAdding(false); reloadInvoices(); }}
        />
      )}
      {addingPayment && (
        <AddPaymentModal
          dealId={dealId}
          proposals={proposals}
          onClose={() => setAddingPayment(false)}
          onCreated={() => { setAddingPayment(false); reload(); }}
        />
      )}
    </Card>
  );
}

function InvoiceRow({ row, dealId, onChanged }) {
  const { showMsg } = useStore();
  const isManual = row.source === 'manual';
  const date = row.issuedAt ? new Date(row.issuedAt).toLocaleDateString('en-GB') : '';
  const statusColor = STATUS_COLOR[row.status] || BRAND.muted;
  const statusLabel = STATUS_LABEL[row.status] || row.status;
  const [markingPaid, setMarkingPaid] = useState(false);
  const [generatingLink, setGeneratingLink] = useState(false);
  const [copied, setCopied] = useState(false);

  const isPaid = row.status === 'paid';
  const isIssued = row.status === 'issued' || row.status === 'authorised';
  const canMarkPaid = isManual && isIssued;
  const hasStripeLink = !!row.stripePaymentLinkUrl;
  const canGenerateLink = isManual && isIssued && !hasStripeLink && row.amount > 0;

  async function handleDelete() {
    if (!confirm('Delete this invoice?')) return;
    try {
      await api.delete('/api/crm/invoices/' + encodeURIComponent(row.id.replace('manual:', '')));
      onChanged?.();
    } catch (err) {
      showMsg?.(err.message || 'Failed to delete', 'error');
    }
  }

  async function handleGenerateLink() {
    setGeneratingLink(true);
    try {
      const rawId = row.id.replace('manual:', '');
      const result = await api.post('/api/stripe/invoice-link', {
        manualInvoiceId: rawId,
        dealId,
      });
      await navigator.clipboard.writeText(result.url).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
      showMsg?.('Stripe payment link created and copied!', 'success');
      onChanged?.();
    } catch (err) {
      showMsg?.(err.message || 'Failed to generate link', 'error');
    } finally {
      setGeneratingLink(false);
    }
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(row.stripePaymentLinkUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      showMsg?.('Link copied to clipboard', 'success');
    } catch {
      showMsg?.('Copy failed', 'error');
    }
  }

  // Payment method badge for paid manual invoices
  const paidMethodLabel = row.paymentMethod
    ? (row.paymentMethod === 'bacs' ? 'BACS' : row.paymentMethod === 'stripe-link' ? 'Stripe' : row.paymentMethod.toUpperCase())
    : null;
  const paidDate = row.paidAt
    ? new Date(row.paidAt).toLocaleDateString('en-GB')
    : null;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'white', border: '1px solid ' + BRAND.border, borderRadius: 6 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, flexWrap: 'wrap' }}>
            {row.amount != null && <span>{formatAmountWithGbp(row.amount, row.currency || 'GBP', row.gbpAmount)}</span>}
            {row.invoiceNumber && <span style={{ fontSize: 11, color: BRAND.muted, fontWeight: 500 }}>{row.invoiceNumber}</span>}
            <span style={{ fontSize: 10, color: statusColor, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }}>{statusLabel}</span>
            {isPaid && paidMethodLabel && (
              <span style={{ fontSize: 10, color: BRAND.muted, fontWeight: 500, padding: '2px 6px', background: BRAND.paper, borderRadius: 4 }}>
                via {paidMethodLabel}
              </span>
            )}
            {!isManual && (
              <span style={{ fontSize: 10, color: BRAND.muted, fontWeight: 500, padding: '2px 6px', background: BRAND.paper, borderRadius: 4 }}>Xero</span>
            )}
          </div>
          <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {row.proposalTitle && <span>{row.proposalTitle}</span>}
            {date && <span>· {date}</span>}
            {isPaid && paidDate && !date && <span>Paid {paidDate}</span>}
            {isPaid && paidDate && date && <span>· Paid {paidDate}</span>}
            {row.filename && <span>· {row.filename}</span>}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {/* Mark as Paid */}
          {canMarkPaid && (
            <button
              onClick={() => setMarkingPaid(true)}
              className="btn-ghost"
              title="Mark as paid"
              style={{ padding: '4px 8px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <CheckCircle size={12} />
              Mark paid
            </button>
          )}

          {/* Copy existing Stripe link */}
          {isManual && hasStripeLink && isIssued && (
            <button onClick={handleCopyLink} className="btn-icon" title="Copy Stripe payment link" style={{ padding: 6 }}>
              {copied ? <Check size={14} color="#16A34A" /> : <Link size={14} color={BRAND.muted} />}
            </button>
          )}

          {/* Generate Stripe link */}
          {canGenerateLink && (
            <button
              onClick={handleGenerateLink}
              disabled={generatingLink}
              className="btn-icon"
              title="Generate Stripe payment link"
              style={{ padding: 6 }}
            >
              {generatingLink
                ? <span style={{ fontSize: 10, color: BRAND.muted }}>…</span>
                : <ExternalLink size={14} color={BRAND.muted} />
              }
            </button>
          )}

          {/* Open PDF */}
          {row.pdfUrl && (
            <button
              onClick={() => window.open(row.pdfUrl, '_blank', 'noopener')}
              className="btn-icon"
              title="View PDF"
              style={{ padding: 6 }}
            >
              <FileText size={14} color={BRAND.muted} />
            </button>
          )}

          {/* Delete (manual only) */}
          {isManual && (
            <button onClick={handleDelete} className="btn-icon" title="Delete" style={{ padding: 6 }}>
              <Trash2 size={14} color={BRAND.muted} />
            </button>
          )}
        </div>
      </div>

      {markingPaid && (
        <MarkInvoicePaidModal
          invoiceId={row.id}
          invoiceNumber={row.invoiceNumber}
          amount={row.amount}
          onClose={() => setMarkingPaid(false)}
          onMarked={() => { setMarkingPaid(false); onChanged?.(); }}
        />
      )}
    </>
  );
}

function StandalonePaymentRow({ row, onChanged }) {
  const { showMsg } = useStore();
  const date = row.paidAt ? new Date(row.paidAt).toLocaleDateString('en-GB') : '';
  const method = methodPretty(row);

  async function handleDelete() {
    if (!confirm('Delete this payment record?')) return;
    try {
      await api.delete('/api/crm/payments/' + encodeURIComponent(row.id.replace('manual:', '')));
      onChanged?.();
    } catch (err) {
      showMsg?.(err.message || 'Failed to delete', 'error');
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 6, opacity: 0.85 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
          <span>{formatCurrency(row.amount, row.currency || 'GBP')}</span>
          <span style={{ fontSize: 11, color: BRAND.muted, fontWeight: 500, padding: '2px 6px', background: 'white', borderRadius: 4 }}>{method}</span>
        </div>
        <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>
          {row.proposalTitle && <span>{row.proposalTitle}</span>}
          {date && <span>{row.proposalTitle ? ' · ' : ''}{date}</span>}
          {row.notes && <span> · {row.notes.slice(0, 40)}</span>}
        </div>
      </div>
      <button onClick={handleDelete} className="btn-icon" title="Delete" style={{ padding: 6 }}>
        <Trash2 size={14} color={BRAND.muted} />
      </button>
    </div>
  );
}

function methodPretty(row) {
  const m = (row.paymentMethod || '').toLowerCase();
  if (m === 'bacs') return 'BACS';
  if (m === 'cheque') return 'Cheque';
  if (m === 'cash') return 'Cash';
  return m ? m.toUpperCase() : 'Manual';
}
