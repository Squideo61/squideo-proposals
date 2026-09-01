import React, { useState, useEffect } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { Modal } from '../ui.jsx';
import { api } from '../../api.js';
import { formatGBP } from '../../utils.js';

let _lineItemKey = 0;
function makeLineItem() {
  return { _key: ++_lineItemKey, description: '', quantity: 1, unitAmount: '', vatRate: 20 };
}

export function CreateXeroInvoiceModal({ dealId, companyId, deals, initialDealId, mode, proposalId, contactName: contactNameProp, initialReference, initialLineItems, onClose, onCreated }) {
  const { showMsg } = useStore();
  const [contactName, setContactName] = useState(contactNameProp || '');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  // Xero invoice Reference — prefilled with the deal's PO number on PO-route deals.
  const [reference, setReference] = useState(initialReference || '');
  const [issuedAt, setIssuedAt] = useState(new Date().toISOString().slice(0, 10));
  const [dueAt, setDueAt] = useState(new Date().toISOString().slice(0, 10));
  // Prefilled when the caller already knows what's being billed — invoicing a
  // recorded sale from Pending Payments, where the line carries the `extraId`
  // that settles the record once the invoice exists.
  const [lineItems, setLineItems] = useState(
    initialLineItems?.length
      ? initialLineItems.map((l) => ({ _key: ++_lineItemKey, ...l }))
      : [makeLineItem()],
  );
  const [saving, setSaving] = useState(false);

  // Company-page mode: let the user attach the invoice to a deal (existing or
  // new) instead of leaving it company-level. Signed deals float to the top.
  const companyMode = !dealId && !!companyId;
  const sortedDeals = (deals || []).slice().sort((a, b) => {
    const sa = a.stage === 'signed' ? 0 : 1;
    const sb = b.stage === 'signed' ? 0 : 1;
    return sa - sb;
  });
  const [dealChoice, setDealChoice] = useState(initialDealId || ''); // '' = company-level, '__new__', or a deal id
  const [newDealTitle, setNewDealTitle] = useState('');
  const [suggestedProposalId, setSuggestedProposalId] = useState(null);
  const [paymentLabel, setPaymentLabel] = useState(null);
  const [loadingLines, setLoadingLines] = useState(false);

  // Is this invoice itself the sale? Raising an invoice and making a sale look
  // identical from here, but only one of them is news: work sold off-proposal is
  // invisible to the sales figures and to Admins/Directors unless it's recorded.
  // "Add extra" always could — you just had to know to. So the modal asks, and
  // won't create the invoice until it's been answered.
  //
  // Lines that arrived carrying an `extraId` are a recorded sale being billed,
  // so there's nothing to ask: recording it again would double-count the money.
  const billsRecordedExtras = (initialLineItems || []).some((l) => l && l.extraId);
  const [saleAnswer, setSaleAnswer] = useState(null); // null (unanswered) | 'yes' | 'no'

  // When a real deal is picked, pull its signed proposal's line items in,
  // honouring the payment plan (full vs 50/50 deposit vs Partner).
  useEffect(() => {
    if (!companyMode) return;
    setSuggestedProposalId(null);
    setPaymentLabel(null);
    setSaleAnswer(null); // a different deal is a different question
    if (!dealChoice || dealChoice === '__new__') return;
    let cancelled = false;
    setLoadingLines(true);
    api.get('/api/crm/invoices/suggested-lines?dealId=' + encodeURIComponent(dealChoice) + (mode === 'final' ? '&mode=final' : ''))
      .then((data) => {
        if (cancelled) return;
        const lines = data?.lineItems || [];
        if (lines.length) {
          setLineItems(lines.map(l => ({ _key: ++_lineItemKey, ...l })));
          setSuggestedProposalId(data.proposalId || null);
          setPaymentLabel(data.paymentLabel || null);
          // Billing a signed proposal's deposit/balance: the sale was counted at
          // signature, so answer for them rather than inviting a double-count.
          if (data.proposalId) setSaleAnswer('no');
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingLines(false); });
    return () => { cancelled = true; };
  }, [dealChoice, companyMode, mode]);

  function updateLine(key, field, value) {
    setLineItems(prev => prev.map(li => li._key === key ? { ...li, [field]: value } : li));
  }

  function removeLine(key) {
    setLineItems(prev => prev.length > 1 ? prev.filter(li => li._key !== key) : prev);
  }

  // Compute per-line and total amounts (inc-VAT for display). A line can carry a
  // discountRate (e.g. the 100%-off free subtitled version) that zeroes it out.
  const lineCalcs = lineItems.map(li => {
    const qty = Number(li.quantity) || 0;
    const price = Number(li.unitAmount) || 0;
    const vat = Number(li.vatRate) || 0;
    const disc = Number(li.discountRate) || 0;
    const exVat = qty * price * (1 - disc / 100);
    const vatAmt = exVat * vat / 100;
    return { exVat, vatAmt, total: exVat + vatAmt };
  });
  // Company-level invoices (no deal at all) have nothing to record the sale
  // against, so the question can't be asked there.
  const askSale = (!!dealId || (companyMode && !!dealChoice)) && !billsRecordedExtras;

  const subtotal = lineCalcs.reduce((s, c) => s + c.exVat, 0);
  const totalVat = lineCalcs.reduce((s, c) => s + c.vatAmt, 0);
  const grandTotal = subtotal + totalVat;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!contactName.trim()) {
      showMsg?.('Contact / company name is required', 'error');
      return;
    }
    const validLines = lineItems.filter(li => li.description.trim() && Number(li.unitAmount) > 0);
    if (!validLines.length) {
      showMsg?.('Add at least one line item with a description and price', 'error');
      return;
    }
    if (companyMode && dealChoice === '__new__' && !newDealTitle.trim()) {
      showMsg?.('Enter a title for the new deal', 'error');
      return;
    }
    if (askSale && saleAnswer === null) {
      showMsg?.('Say whether this invoice is a new sale', 'error');
      return;
    }
    setSaving(true);
    try {
      // Resolve the scope: a chosen/created deal, or company-level.
      let scopeDealId = dealId || undefined;
      let scopeCompanyId = companyId || undefined;
      let scopeProposalId = proposalId || undefined;
      if (companyMode) {
        if (dealChoice === '__new__') {
          const deal = await api.post('/api/crm/deals', { title: newDealTitle.trim(), companyId });
          scopeDealId = deal.id;
          scopeCompanyId = undefined;
          scopeProposalId = undefined;
        } else if (dealChoice) {
          scopeDealId = dealChoice;
          scopeCompanyId = undefined;
          scopeProposalId = suggestedProposalId || undefined; // link to the signed proposal we pulled from
        }
        // else: leave company-level (scopeCompanyId stays set)
      }
      const result = await api.post('/api/crm/invoices', {
        dealId: scopeDealId,
        companyId: scopeDealId ? undefined : scopeCompanyId,
        proposalId: scopeProposalId,
        contactName: contactName.trim(),
        invoiceNumber: invoiceNumber.trim() || undefined,
        reference: reference.trim() || undefined,
        issuedAt,
        dueAt: dueAt || undefined,
        lineItems: validLines.map(li => ({
          description: li.description.trim(),
          quantity: Number(li.quantity) || 1,
          unitAmount: Number(li.unitAmount),
          vatRate: Number(li.vatRate) || 0,
          discountRate: li.discountRate ? Number(li.discountRate) : undefined,
        })),
        // Pre-filled extra lines carry their id so the server can mark those
        // deal_extras 'invoiced' (and settle them when the invoice is paid).
        // Lines the user removed before submitting drop out here.
        extraIds: validLines.map(li => li.extraId).filter(Boolean),
        // Yes → the server records the billed lines as a sale on the deal and
        // alerts Admins + Directors that this person sold it.
        recordAsSale: askSale && saleAnswer === 'yes',
      });
      showMsg?.(result?.recordedAsSale ? 'Invoice created in Xero and recorded as a sale' : 'Invoice created in Xero', 'success');
      onCreated?.(result);
    } catch (err) {
      showMsg?.(err.message || 'Failed to create invoice', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} maxWidth={740} showClose={false}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Create Xero invoice</h2>
        <button onClick={onClose} className="btn-icon" aria-label="Close"><X size={16} /></button>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Contact + invoice number */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Contact / company">
            <input
              type="text"
              value={contactName}
              onChange={e => setContactName(e.target.value)}
              className="input"
              placeholder="Company or client name"
              required
            />
          </Field>
          <Field label="Invoice number">
            <input
              type="text"
              value={invoiceNumber}
              onChange={e => setInvoiceNumber(e.target.value)}
              className="input"
              placeholder="Auto-assigned by Xero (e.g. INV-6059)"
            />
          </Field>
        </div>

        {/* Reference (prints on the Xero invoice). Prefilled with the PO number
            for PO-route deals so it lands as the customer's PO reference. */}
        <Field label="Reference">
          <input
            type="text"
            value={reference}
            onChange={e => setReference(e.target.value)}
            className="input"
            placeholder="e.g. the customer's PO number"
          />
        </Field>

        {/* Deal association (company page only) */}
        {companyMode && (
          <Field label="Deal">
            <select className="input" value={dealChoice} onChange={e => setDealChoice(e.target.value)}>
              <option value="">No specific deal (bill the company)</option>
              {sortedDeals.map(d => (
                <option key={d.id} value={d.id}>
                  {d.title}{d.stage ? ` — ${d.stage}` : ''}{d.value != null ? ` · ${formatGBP(d.value)}` : ''}
                </option>
              ))}
              <option value="__new__">+ Create a new deal…</option>
            </select>
            {dealChoice === '__new__' && (
              <input
                className="input"
                style={{ marginTop: 8 }}
                value={newDealTitle}
                onChange={e => setNewDealTitle(e.target.value)}
                placeholder="New deal title (e.g. Brand video 2026)"
              />
            )}
            {loadingLines && (
              <div style={{ fontSize: 12, color: BRAND.muted, marginTop: 6 }}>Pulling in the signed proposal…</div>
            )}
            {!loadingLines && paymentLabel && (
              <div style={{ fontSize: 12, color: '#15803D', marginTop: 6 }}>
                Itemised from the signed proposal — {paymentLabel}.
              </div>
            )}
          </Field>
        )}

        {/* Dates */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Issue date">
            <input type="date" value={issuedAt} onChange={e => setIssuedAt(e.target.value)} className="input" />
          </Field>
          <Field label="Due date">
            <input type="date" value={dueAt} onChange={e => setDueAt(e.target.value)} className="input" />
          </Field>
        </div>

        {/* Line items */}
        <div>
          <div style={{ fontSize: 11, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
            Line items
          </div>
          <div style={{ border: '1px solid ' + BRAND.border, borderRadius: 8, overflow: 'hidden' }}>
            {/* Column headers */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 60px 104px 68px 76px 28px',
              gap: 6,
              background: BRAND.paper,
              borderBottom: '1px solid ' + BRAND.border,
              padding: '5px 10px',
              fontSize: 10,
              color: BRAND.muted,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}>
              <span>Description</span>
              <span style={{ textAlign: 'right' }}>Qty</span>
              <span style={{ textAlign: 'right' }}>Unit price (£)</span>
              <span style={{ textAlign: 'center' }}>VAT</span>
              <span style={{ textAlign: 'right' }}>Amount</span>
              <span />
            </div>

            {/* Rows */}
            {lineItems.map((li, idx) => {
              const calc = lineCalcs[idx];
              return (
                <div
                  key={li._key}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 60px 104px 68px 76px 28px',
                    gap: 6,
                    padding: '6px 10px',
                    alignItems: 'center',
                    borderBottom: idx < lineItems.length - 1 ? '1px solid ' + BRAND.border : 'none',
                  }}
                >
                  <input
                    type="text"
                    value={li.description}
                    onChange={e => updateLine(li._key, 'description', e.target.value)}
                    className="input"
                    style={{ fontSize: 12 }}
                    placeholder="e.g. Video animation"
                  />
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={li.quantity}
                    onChange={e => updateLine(li._key, 'quantity', e.target.value)}
                    className="input"
                    style={{ fontSize: 12, textAlign: 'right' }}
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={li.unitAmount}
                    onChange={e => updateLine(li._key, 'unitAmount', e.target.value)}
                    className="input"
                    style={{ fontSize: 12, textAlign: 'right' }}
                    placeholder="0.00"
                  />
                  <select
                    value={li.vatRate}
                    onChange={e => updateLine(li._key, 'vatRate', Number(e.target.value))}
                    className="input"
                    style={{ fontSize: 12 }}
                  >
                    <option value={20}>20%</option>
                    <option value={0}>0%</option>
                  </select>
                  <span style={{ fontSize: 12, fontWeight: 600, textAlign: 'right', color: Number(li.discountRate) >= 100 ? '#15803D' : (calc.total > 0 ? BRAND.ink : BRAND.muted) }}>
                    {Number(li.discountRate) >= 100
                      ? 'FREE'
                      : (calc.total > 0 ? formatGBP(calc.total) : '—')}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeLine(li._key)}
                    className="btn-icon"
                    disabled={lineItems.length === 1}
                    style={{ padding: 3 }}
                    title="Remove line"
                  >
                    <Trash2 size={12} color={BRAND.muted} />
                  </button>
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => setLineItems(prev => [...prev, makeLineItem()])}
            className="btn-ghost"
            style={{ marginTop: 6, fontSize: 12 }}
          >
            <Plus size={12} /> Add line
          </button>
        </div>

        {/* Totals */}
        {grandTotal > 0 && (
          <div style={{ alignSelf: 'flex-end', minWidth: 230, borderTop: '1px solid ' + BRAND.border, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <TotalRow label="Subtotal (ex VAT)" value={formatGBP(subtotal)} />
            {totalVat > 0 && <TotalRow label="VAT" value={formatGBP(totalVat)} />}
            <TotalRow label="Total" value={formatGBP(grandTotal)} bold />
          </div>
        )}

        {/* Is this invoice a new sale? Sits next to the Create button because
            that's the last thing anyone reads. */}
        {askSale && (
          <div style={{
            border: '1px solid ' + (saleAnswer === null ? '#F59E0B' : BRAND.border),
            background: saleAnswer === null ? '#FFFBEB' : BRAND.paper,
            borderRadius: 8,
            padding: 12,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Is this a new sale?</div>
            <div style={{ fontSize: 12, color: BRAND.muted, marginBottom: 10 }}>
              Say yes for work sold on top of (or instead of) a signed proposal — it's recorded
              against the project and the directors and admins are told you sold it.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <SaleChoice
                selected={saleAnswer === 'yes'}
                onClick={() => setSaleAnswer('yes')}
                label="Yes — record it as a sale"
                hint="New work, not already on the books"
              />
              <SaleChoice
                selected={saleAnswer === 'no'}
                onClick={() => setSaleAnswer('no')}
                label="No — just an invoice"
                hint="Bills something already recorded"
              />
            </div>
            {suggestedProposalId && saleAnswer === 'yes' && (
              <div style={{ fontSize: 12, color: '#B45309', marginTop: 8 }}>
                These lines came from the signed proposal, which already counts as a sale —
                only say yes if you've changed them to something extra.
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" className="btn" disabled={saving}>
            {saving ? 'Creating in Xero…' : 'Create invoice'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// One of the two answers to "Is this a new sale?" — a pressed-state button
// rather than a radio so the unanswered state is visibly unanswered.
function SaleChoice({ selected, onClick, label, hint }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      style={{
        flex: '1 1 200px',
        textAlign: 'left',
        cursor: 'pointer',
        border: '1.5px solid ' + (selected ? BRAND.blue : BRAND.border),
        background: selected ? 'rgba(56,189,248,0.10)' : '#fff',
        borderRadius: 8,
        padding: '8px 10px',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: BRAND.ink }}>{label}</div>
      <div style={{ fontSize: 11, color: BRAND.muted, marginTop: 1 }}>{hint}</div>
    </button>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 11, color: BRAND.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </label>
  );
}

function TotalRow({ label, value, bold }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: bold ? 700 : 400, color: bold ? BRAND.ink : BRAND.muted }}>
      <span>{label}</span>
      <span style={{ color: BRAND.ink }}>{value}</span>
    </div>
  );
}
