import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { api } from '../../api.js';
import { Modal } from '../ui.jsx';
import { formatGBP } from '../../utils.js';

// Record an ad-hoc "extra" charge against a deal (extra video, human VO, extra
// revisions…). Stage 1 is record-only: the extra is saved and shows as its own
// pending line in Pending Payments, to be invoiced later.
//
// The same modal in `variant="sale"` records the whole sale on a deal that has
// no signed proposal and never will — revisions to a job that pre-dates the CRM,
// say. Nothing about the record differs; the words do, because "an extra on top
// of the signed total" describes neither the money nor the deal.
// How an extra is billed. Labels are the dropdown copy.
const PAYMENT_OPTIONS = [
  { value: 'final', label: 'Add to the final invoice', hint: 'Sits on the deal and rides the 50% final invoice for the project.' },
  { value: 'invoice_now', label: 'Create invoice now', hint: 'Raises a Xero invoice for this charge straight away.' },
  { value: 'existing_invoice', label: 'Add to an existing invoice', hint: 'Appends this charge as a line on one of the deal’s open Xero invoices, so it’s billed on that invoice.' },
  { value: 'po', label: 'Purchase order — generate a quote to raise a PO', hint: 'Raises a Xero quote (reference “Pending PO”); turn it into an invoice from the Purchase Orders section once the PO lands.' },
];

// Sale mode. There's no final invoice to ride, so "invoice later" is its own
// option, and the PO route can't raise a quote against a project that was never
// quoted — it just waits for the client's PO number.
const SALE_PAYMENT_OPTIONS = [
  { value: 'final', label: 'Invoice later', hint: 'Sits in Pending Payments as not-yet-invoiced until you raise the invoice.' },
  { value: 'po_awaited', label: 'On a purchase order (not raised yet)', hint: 'Shows under Purchase Orders as “Pending PO”. Record the PO number when it arrives, then invoice against it.' },
  { value: 'invoice_now', label: 'Create invoice now', hint: 'Raises a Xero invoice for this sale straight away.' },
  { value: 'existing_invoice', label: 'Add to an existing invoice', hint: 'Appends this sale as a line on one of the deal’s open Xero invoices.' },
];

// An open Xero invoice can still take a new line; paid/voided ones can't.
const isOpenInvoice = (inv) => inv && inv.xeroInvoiceId && (inv.status === 'issued' || inv.status === 'authorised');

export function AddExtraModal({ dealId, deals, onClose, onCreated, variant = 'extra', defaultAmount = null }) {
  const { showMsg } = useStore();
  const saleMode = variant === 'sale';
  const options = saleMode ? SALE_PAYMENT_OPTIONS : PAYMENT_OPTIONS;
  const dealOptions = (deals || []).filter((d) => d && d.id);
  const [selectedDealId, setSelectedDealId] = useState(dealId || (dealOptions[0]?.id ?? ''));
  const [description, setDescription] = useState('');
  // Prefilled from the deal's value in sale mode, so the recorded sale and the
  // pipeline figure agree — Marketing counts the deal's value, Finance counts
  // this. Editable: it's a suggestion, not a rewrite.
  const [amount, setAmount] = useState(saleMode && Number(defaultAmount) > 0 ? String(defaultAmount) : '');
  const [paymentType, setPaymentType] = useState('final');
  const [saving, setSaving] = useState(false);
  // Open invoices for the chosen deal — loaded only when "existing invoice" is
  // picked (and re-loaded if the deal changes). null = not loaded yet.
  const [openInvoices, setOpenInvoices] = useState(null);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [xeroInvoiceId, setXeroInvoiceId] = useState('');

  const effectiveDealId = dealId || selectedDealId;

  useEffect(() => {
    if (paymentType !== 'existing_invoice' || !effectiveDealId) return;
    let cancelled = false;
    setLoadingInvoices(true);
    setOpenInvoices(null);
    api.get('/api/crm/invoices?dealId=' + encodeURIComponent(effectiveDealId))
      .then((rows) => {
        if (cancelled) return;
        const open = (rows || []).filter(isOpenInvoice);
        setOpenInvoices(open);
        setXeroInvoiceId(open[0]?.xeroInvoiceId || '');
      })
      .catch(() => { if (!cancelled) setOpenInvoices([]); })
      .finally(() => { if (!cancelled) setLoadingInvoices(false); });
    return () => { cancelled = true; };
  }, [paymentType, effectiveDealId]);

  const amountNum = Number(amount);
  const needsInvoice = paymentType === 'existing_invoice';
  const canSubmit = !!effectiveDealId && description.trim() && amountNum > 0 && !saving
    && (!needsInvoice || !!xeroInvoiceId);
  const option = options.find((o) => o.value === paymentType) || options[0];
  const submitLabel = paymentType === 'invoice_now' ? 'Create invoice'
    : paymentType === 'po' ? 'Generate PO quote'
    : paymentType === 'existing_invoice' ? 'Add to invoice'
    : saleMode ? 'Record sale'
    : 'Add extra';
  const savingLabel = paymentType === 'invoice_now' ? 'Creating invoice…'
    : paymentType === 'po' ? 'Generating quote…'
    : paymentType === 'existing_invoice' ? 'Adding to invoice…'
    : saleMode ? 'Recording…'
    : 'Adding…';

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    try {
      const row = await api.post('/api/crm/extras', {
        dealId: effectiveDealId,
        description: description.trim(),
        amount: amountNum,
        paymentType,
        ...(needsInvoice ? { xeroInvoiceId } : {}),
      });
      showMsg?.(paymentType === 'po' ? 'PO quote raised'
        : paymentType === 'invoice_now' ? 'Invoice created'
        : paymentType === 'existing_invoice' ? 'Added to invoice'
        : saleMode ? 'Sale recorded'
        : 'Extra added', 'success');
      onCreated?.(row);
    } catch (err) {
      showMsg?.(err.message || (saleMode ? 'Failed to record the sale' : 'Failed to add extra'), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} showClose={false}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{saleMode ? 'Record a sale' : 'Add extra charge'}</h2>
        <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
      </div>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 12, color: BRAND.muted }}>
          {saleMode
            ? 'Work sold on this deal, which has no proposal to sign. It counts as a sale straight away, sits in Pending Payments until it’s invoiced and paid, and earns the deal owner commission when the money lands.'
            : 'An extra charge added during production (e.g. an extra video or human VO) — on top of the signed total. Choose how it should be billed below.'}
        </p>

        {!dealId && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: BRAND.muted }}>Project / deal</span>
            <select
              value={selectedDealId}
              onChange={(e) => setSelectedDealId(e.target.value)}
              className="input"
            >
              {dealOptions.length === 0 && <option value="">No deals available</option>}
              {dealOptions.map((d) => (
                <option key={d.id} value={d.id}>{d.title || d.id}</option>
              ))}
            </select>
          </label>
        )}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: BRAND.muted }}>Description</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={saleMode ? 'e.g. Revisions to the AON explainer' : 'e.g. Human VO, additional revisions'}
            className="input"
            autoFocus
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: BRAND.muted }}>Amount (ex-VAT)</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="input"
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: BRAND.muted }}>How will this be paid?</span>
          <select value={paymentType} onChange={(e) => setPaymentType(e.target.value)} className="input">
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <span style={{ fontSize: 11.5, color: BRAND.muted }}>{option.hint}</span>
        </label>

        {needsInvoice && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: BRAND.muted }}>Which invoice?</span>
            {loadingInvoices ? (
              <span style={{ fontSize: 12, color: BRAND.muted }}>Loading invoices…</span>
            ) : (openInvoices && openInvoices.length > 0) ? (
              <>
                <select value={xeroInvoiceId} onChange={(e) => setXeroInvoiceId(e.target.value)} className="input">
                  {openInvoices.map((inv) => (
                    <option key={inv.xeroInvoiceId} value={inv.xeroInvoiceId}>
                      {(inv.invoiceNumber || 'Invoice')}{inv.amount != null ? ` — ${formatGBP(inv.amount)}` : ''}
                    </option>
                  ))}
                </select>
                <span style={{ fontSize: 11.5, color: BRAND.muted }}>The charge is added as a new line, so this invoice’s total goes up by {amountNum > 0 ? formatGBP(amountNum) : 'the amount'} (+ VAT).</span>
              </>
            ) : (
              <span style={{ fontSize: 11.5, color: '#B45309' }}>
                No open invoices on this deal to add to. Use “Create invoice now” instead, or raise the final invoice first.
              </span>
            )}
          </label>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={!canSubmit}>
            {saving ? savingLabel : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
