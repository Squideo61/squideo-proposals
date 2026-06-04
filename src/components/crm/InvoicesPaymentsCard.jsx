import React, { useEffect, useState, useCallback } from 'react';
import { Plus, FileText, Trash2, CheckCircle, Link, Copy, Check, ExternalLink } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { formatGBP, formatCurrency, formatAmountWithGbp } from '../../utils.js';
import { api } from '../../api.js';
import { Card, Empty } from './Card.jsx';
import { AddInvoiceModal } from './AddInvoiceModal.jsx';
import { MarkInvoicePaidModal } from './MarkInvoicePaidModal.jsx';
import { CreateXeroInvoiceModal } from './CreateXeroInvoiceModal.jsx';
import { AddExtraModal } from './AddExtraModal.jsx';

// Open the invoice PDF with a filename-friendly URL so "Save as" defaults to the
// invoice number (e.g. INV-6082.pdf) — browsers use the URL's last path segment.
// Only the Xero passthrough needs this; the blob route already names its file.
function pdfHref(row) {
  const url = row.pdfUrl;
  if (url && url.startsWith('/api/xero/invoice-pdf?') && row.invoiceNumber) {
    const qs = url.slice(url.indexOf('?'));
    return `/api/xero/invoice-pdf/${encodeURIComponent(row.invoiceNumber)}.pdf${qs}`;
  }
  return url;
}

const STATUS_LABEL = { authorised: 'Issued', issued: 'Issued', paid: 'Paid', void: 'Void' };
const STATUS_COLOR = {
  authorised: BRAND.muted,
  issued: BRAND.muted,
  paid: '#16A34A',
  void: '#DC2626',
};

export function InvoicesPaymentsCard({ dealId, companyId, proposals, contactName, deals, vatRate, onChanged, openCreateSignal, preselectDealId }) {
  const { showMsg } = useStore();
  // Figures are stored inc-VAT; show them ex-VAT with "+VAT" to match invoices.
  const vr = Number(vatRate) || 0;
  const vatSuffix = vr > 0 ? ' +VAT' : '';
  const fmtEx = (inc) => formatGBP((Number(inc) || 0) / (1 + vr)) + vatSuffix;
  const [invoices, setInvoices] = useState(null);
  const [payments, setPayments] = useState(null);
  const [adding, setAdding] = useState(false);
  const [creatingXero, setCreatingXero] = useState(false);
  const [addingExtra, setAddingExtra] = useState(false);
  const [extras, setExtras] = useState(null);
  // When creating from a "not invoiced" card we target a specific deal and pull
  // the appropriate portion: the balance if a deposit's already been raised,
  // else the first (deposit/full) invoice.
  const [createDealId, setCreateDealId] = useState(null);
  const [createMode, setCreateMode] = useState(null);

  function openCreate({ dealId: dId = null, mode = null } = {}) {
    setCreateDealId(dId);
    setCreateMode(mode);
    setCreatingXero(true);
  }

  // Parent can ask us to open the create-invoice modal (e.g. the company page's
  // "Invoice needs generating" banner button), optionally preselecting a deal.
  useEffect(() => {
    if (openCreateSignal) openCreate({ dealId: preselectDealId || null });
  }, [openCreateSignal]);

  // Scope by deal or, on the company page, by company.
  const scopeQs = dealId
    ? 'dealId=' + encodeURIComponent(dealId)
    : 'companyId=' + encodeURIComponent(companyId);

  const reloadInvoices = useCallback(() => {
    api.get('/api/crm/invoices?' + scopeQs)
      .then(setInvoices)
      .catch((err) => { showMsg?.(err.message || 'Failed to load invoices', 'error'); setInvoices([]); });
  }, [scopeQs, showMsg]);

  const reloadPayments = useCallback(() => {
    api.get('/api/crm/payments?' + scopeQs)
      .then(rows => {
        // Only keep manual payments that are not linked to a manual_invoice
        // (linked ones are represented by the invoice's paid status instead).
        setPayments(rows.filter(r => r.source === 'manual' && !r.manualInvoiceId));
      })
      .catch((err) => { showMsg?.(err.message || 'Failed to load payments', 'error'); setPayments([]); });
  }, [scopeQs, showMsg]);

  // Extras are deal-scoped; only the deal page lists/manages them (they still
  // surface globally in Pending Payments). The company page can add via the
  // modal's deal picker but doesn't list them here.
  const reloadExtras = useCallback(() => {
    if (!dealId) { setExtras([]); return; }
    api.get('/api/crm/extras?dealId=' + encodeURIComponent(dealId))
      .then(setExtras)
      .catch(() => setExtras([]));
  }, [dealId]);

  const reload = useCallback(() => {
    reloadInvoices();
    reloadPayments();
    reloadExtras();
  }, [reloadInvoices, reloadPayments, reloadExtras]);

  useEffect(() => { reload(); }, [reload]);

  const loading = invoices === null || payments === null;
  const allInvoices = invoices || [];
  const standAlonePayments = payments || [];

  // Three buckets, plus the not-invoiced balances derived from each deal.
  const notInvoicedDeals = (deals || []).filter(d => d.balance && d.balance.notInvoiced > 0);
  const paidInvoices = allInvoices.filter(r => r.status === 'paid');
  const outstandingInvoices = allInvoices.filter(r => r.status !== 'paid'); // issued/authorised (+ any void)

  // Totals are summed per-currency — we don't FX-convert non-GBP into a single
  // bucket, so each currency renders as its own subtotal.
  const paidRows = [...paidInvoices, ...standAlonePayments];
  const totalsByCurrency = paidRows.reduce((acc, r) => {
    const ccy = r.currency || 'GBP';
    acc[ccy] = (acc[ccy] || 0) + (Number(r.amount) || 0);
    return acc;
  }, {});
  const totalEntries = Object.entries(totalsByCurrency).filter(([, v]) => v > 0);

  const pendingExtras = (extras || []).filter((e) => e.status !== 'paid');

  async function deleteExtra(id) {
    try {
      await api.delete('/api/crm/extras/' + encodeURIComponent(id));
      reloadExtras();
      onChanged?.();
    } catch (err) {
      showMsg?.(err.message || 'Failed to remove extra', 'error');
    }
  }

  const count = allInvoices.length + standAlonePayments.length;
  const isEmpty = count === 0 && notInvoicedDeals.length === 0 && pendingExtras.length === 0;

  return (
    <Card
      title="Invoices & Payments"
      count={count || undefined}
      action={(
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => openCreate()} className="btn"><Plus size={12} /> Create invoice</button>
          <button onClick={() => setAdding(true)} className="btn-ghost"><Plus size={12} /> Upload invoice</button>
          <button onClick={() => setAddingExtra(true)} className="btn-ghost"><Plus size={12} /> Add extra</button>
        </div>
      )}
    >
      {loading && <div style={{ padding: '12px 4px', fontSize: 13, color: BRAND.muted }}>Loading…</div>}

      {!loading && isEmpty && <Empty text="No invoices or payments yet" />}

      {/* Outstanding balances — signed work not yet invoiced (e.g. the final 50%) */}
      {!loading && notInvoicedDeals.length > 0 && (
        <>
          <SectionLabel>Outstanding balances — not invoiced</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {notInvoicedDeals.map(d => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 10px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 6 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    {d.title} <span style={{ color: '#92400E' }}>· {fmtEx(d.balance.notInvoiced)}</span>
                  </div>
                  <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 2 }}>
                    {d.balance.invoiced > 0
                      ? `${fmtEx(d.balance.invoiced)} invoiced of ${fmtEx(d.balance.committed)} signed`
                      : `${fmtEx(d.balance.committed)} signed · nothing invoiced yet`}
                  </div>
                </div>
                <button
                  onClick={() => openCreate({ dealId: d.id, mode: d.balance.invoiced > 0 ? 'final' : null })}
                  className="btn"
                  style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                >
                  <Plus size={12} /> Create invoice
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Extras — ad-hoc charges added during production, to invoice later */}
      {!loading && pendingExtras.length > 0 && (
        <>
          <SectionLabel>Extras — to invoice</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pendingExtras.map((e) => (
              <div key={e.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 10px', background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: '#C2410C', background: '#FFEDD5', padding: '1px 6px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.3, flexShrink: 0 }}>Extra</span>
                  <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.description}</span>
                  <span style={{ fontSize: 13, color: '#9A3412', flexShrink: 0 }}>· {formatGBP(e.amount)}{vatSuffix}</span>
                </div>
                <button onClick={() => deleteExtra(e.id)} className="btn-icon" aria-label="Remove extra" title="Remove extra">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Invoiced — outstanding (raised, not yet paid) */}
      {!loading && outstandingInvoices.length > 0 && (
        <>
          <SectionLabel>Invoiced — outstanding</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {outstandingInvoices.map(r => (
              <InvoiceRow key={r.id} row={r} dealId={dealId} onChanged={reload} />
            ))}
          </div>
        </>
      )}

      {/* Paid (paid invoices + standalone payments) */}
      {!loading && (paidInvoices.length > 0 || standAlonePayments.length > 0) && (
        <>
          <SectionLabel>Paid</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {paidInvoices.map(r => (
              <InvoiceRow key={r.id} row={r} dealId={dealId} onChanged={reload} />
            ))}
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
              <span style={{ fontWeight: 600, color: BRAND.ink }}>{formatCurrency(total / (1 + vr), ccy)}{vatSuffix}</span>
            </div>
          ))}
        </div>
      )}

      {creatingXero && (
        <CreateXeroInvoiceModal
          dealId={dealId}
          companyId={companyId}
          deals={deals}
          initialDealId={createDealId || preselectDealId}
          mode={createMode}
          contactName={contactName}
          onClose={() => setCreatingXero(false)}
          onCreated={() => { setCreatingXero(false); reloadInvoices(); onChanged?.(); }}
        />
      )}
      {adding && (
        <AddInvoiceModal
          dealId={dealId}
          companyId={companyId}
          proposals={proposals}
          onClose={() => setAdding(false)}
          onCreated={() => { setAdding(false); reloadInvoices(); onChanged?.(); }}
        />
      )}
      {addingExtra && (
        <AddExtraModal
          dealId={dealId}
          deals={deals}
          onClose={() => setAddingExtra(false)}
          onCreated={() => { setAddingExtra(false); reloadExtras(); onChanged?.(); }}
        />
      )}
    </Card>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 11, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, margin: '14px 0 6px' }}>
      {children}
    </div>
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
  // Manual invoices mark paid in our DB; Xero-sourced invoices (with a known
  // amount) record the payment straight in Xero via the xero-pay endpoint.
  const canMarkPaid = isIssued && (isManual || (!!row.xeroInvoiceId && row.amount > 0));
  const hasStripeLink = !!row.stripePaymentLinkUrl;
  const canGenerateLink = isManual && isIssued && !hasStripeLink && row.amount > 0;

  async function handleDelete() {
    if (!confirm('⚠ Warning: deleting this invoice will VOID it in Xero and CANNOT be undone.\n\nAre you sure you want to delete this invoice?')) return;
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
        dealId: row.dealId || dealId || undefined,
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
    ? (row.paymentMethod === 'bacs' ? 'BACS'
      : row.paymentMethod === 'stripe-link' ? 'Stripe'
      : row.paymentMethod === 'stripe-standalone' ? 'Stripe'
      : row.paymentMethod.toUpperCase())
    : null;
  const paidDate = row.paidAt
    ? new Date(row.paidAt).toLocaleDateString('en-GB')
    : null;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: isPaid ? 'white' : '#FFFBEB', border: '1px solid ' + (isPaid ? BRAND.border : '#FDE68A'), borderRadius: 6 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, flexWrap: 'wrap' }}>
            {row.subtotalExVat != null ? (
              <>
                <span>{formatAmountWithGbp(row.subtotalExVat, row.currency || 'GBP', row.gbpSubtotalExVat)}</span>
                <span style={{ fontSize: 10, color: BRAND.muted, fontWeight: 500, padding: '2px 6px', background: BRAND.paper, borderRadius: 4 }}>
                  {row.taxAmount > 0 ? '+ VAT' : 'No VAT'}
                </span>
              </>
            ) : row.amount != null ? (
              <span>{formatAmountWithGbp(row.amount, row.currency || 'GBP', row.gbpAmount)}</span>
            ) : null}
            {row.invoiceNumber && <span style={{ fontSize: 11, color: BRAND.muted, fontWeight: 500 }}>{row.invoiceNumber}</span>}
            {row.planLabel && (
              <span style={{ fontSize: 10, color: '#15803D', fontWeight: 600, padding: '2px 6px', background: '#ECFDF3', borderRadius: 4 }}>{row.planLabel}</span>
            )}
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
              onClick={() => window.open(pdfHref(row), '_blank', 'noopener')}
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
          xeroInvoiceId={isManual ? undefined : row.xeroInvoiceId}
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
