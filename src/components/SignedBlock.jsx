import React, { useEffect, useRef, useState } from 'react';
import { Check, Download, FileText } from 'lucide-react';
import { BRAND } from '../theme.js';
import { formatGBP } from '../utils.js';
import { BillingFields, emptyBilling, isBillingValid } from './BillingFields.jsx';

export function SignedBlock({ signed, payment, paymentChoice, vatRate, onPayNow, onChooseInvoice, onUndoInvoice, onConfirmInvoice, onPoConfirm, onDownloadReceipt, onDownloadSignedProposal }) {
  const isPO = signed.paymentOption === 'po';
  const amountDue = signed.paymentOption === '5050' ? signed.total / 2 : signed.total;
  const isDeposit = signed.paymentOption === '5050';
  const totalExVat = vatRate ? signed.total / (1 + vatRate) : signed.total;

  const [billing, setBilling] = useState(() => emptyBilling(signed.email));
  const [invoiceSubmitting, setInvoiceSubmitting] = useState(false);
  const [invoiceConfirmed, setInvoiceConfirmed] = useState(false);
  const [highlightBilling, setHighlightBilling] = useState(false);
  const invoicePanelRef = useRef(null);
  const billingValid = isBillingValid(billing);

  // When the client clicks "Skip - send me an invoice", scroll the new
  // billing panel into view and pulse a highlight ring on the form so it's
  // obvious they still have to fill those fields in.
  useEffect(() => {
    if (paymentChoice !== 'invoice' || invoiceConfirmed) {
      setHighlightBilling(false);
      return;
    }
    const scrollT = setTimeout(() => {
      invoicePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
    setHighlightBilling(true);
    const offT = setTimeout(() => setHighlightBilling(false), 2600);
    return () => { clearTimeout(scrollT); clearTimeout(offT); };
  }, [paymentChoice, invoiceConfirmed]);

  const submitInvoice = async () => {
    if (!billingValid || !onConfirmInvoice) return;
    setInvoiceSubmitting(true);
    try {
      await onConfirmInvoice({ billing });
      setInvoiceConfirmed(true);
    } finally {
      setInvoiceSubmitting(false);
    }
  };

  const submitPO = async () => {
    if (!billingValid || !onPoConfirm) return;
    setInvoiceSubmitting(true);
    try {
      await onPoConfirm({ billing });
      setInvoiceConfirmed(true);
    } finally {
      setInvoiceSubmitting(false);
    }
  };

  return (
    <div>
      <div style={{ background: '#E8F5E9', border: '2px solid #66BB6A', borderRadius: 12, padding: 24, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <Check size={24} color="#2E7D32" />
          <h3 style={{ margin: 0, color: '#1B5E20', fontSize: 18 }}>Proposal Accepted</h3>
        </div>
        <div style={{ fontSize: 14, color: '#2E7D32', lineHeight: 1.6 }}>
          <div>Signed by <strong>{signed.name}</strong> ({signed.email})</div>
          <div>On {new Date(signed.signedAt).toLocaleString('en-GB')}</div>
          {signed.partnerSelected && signed.amountBreakdown ? (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #A5D6A7' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Project (discounted)</span>
                <span><strong>{formatGBP(signed.amountBreakdown.projectExVat)}</strong> + VAT</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>First month Partner Programme</span>
                <span><strong>{formatGBP(signed.amountBreakdown.partnerExVat)}</strong> + VAT</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, paddingTop: 6, borderTop: '1px solid #A5D6A7', fontWeight: 700 }}>
                <span>Total committed today</span>
                <span>{formatGBP(signed.amountBreakdown.projectExVat + signed.amountBreakdown.partnerExVat)} + VAT</span>
              </div>
              <div style={{ fontSize: 12, color: '#15803D', marginTop: 6 }}>
                Then {formatGBP(signed.amountBreakdown.partnerExVat)} + VAT / month - cancel any time.
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 8 }}>Total committed: <strong>{formatGBP(totalExVat)} + VAT</strong></div>
          )}
        </div>
        {onDownloadSignedProposal && (
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #A5D6A7' }}>
            <button
              onClick={onDownloadSignedProposal}
              className="btn"
              style={{ width: '100%', justifyContent: 'center', padding: '12px 16px', fontSize: 14, background: '#2E7D32' }}
            >
              <FileText size={16} /> Download Signed Proposal
            </button>
          </div>
        )}
      </div>

      {payment && (
        <div style={{ background: 'white', border: '2px solid ' + BRAND.blue, borderRadius: 12, padding: 24 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 17, fontWeight: 700 }}>Payment Received</h3>
          <div style={{ fontSize: 14, lineHeight: 1.7 }}>
            <div><strong>{formatGBP(payment.amount)}</strong> paid {payment.paymentType === 'deposit' ? '(50% deposit)' : '(full payment)'}</div>
            <div style={{ color: BRAND.muted, fontSize: 13 }}>On {new Date(payment.paidAt).toLocaleString('en-GB')}</div>
          </div>
          {onDownloadReceipt && (
            <div style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid ' + BRAND.border }}>
              <button onClick={onDownloadReceipt} className="btn" style={{ width: '100%', justifyContent: 'center', padding: '12px 16px', fontSize: 14 }}>
                <Download size={16} /> Download Receipt
              </button>
            </div>
          )}
        </div>
      )}

      {!payment && isPO && invoiceConfirmed && (
        <div style={{ background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 20 }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 600 }}>Quote sent — pending your PO</h4>
          <p style={{ fontSize: 13, color: BRAND.muted, margin: 0, lineHeight: 1.5 }}>
            We've issued a Xero quote for {formatGBP(amountDue)} to {billing.accountsEmail || signed.email}. Please raise your Purchase Order against it and our team will be in touch to confirm.
          </p>
        </div>
      )}

      {!payment && isPO && !invoiceConfirmed && (
        <div style={{ background: 'white', border: '2px solid ' + BRAND.blue, borderRadius: 12, padding: 24 }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700 }}>Your billing details</h3>
          <p style={{ fontSize: 14, color: BRAND.muted, marginTop: 6, marginBottom: 16, lineHeight: 1.5 }}>
            Confirm your billing details and we'll issue a Xero quote for {formatGBP(amountDue)} so you can raise your Purchase Order.
          </p>
          <BillingFields
            value={billing}
            onChange={setBilling}
            subtitle="We'll issue a quote to this contact in Xero with reference 'Pending PO'."
          />
          <button
            onClick={submitPO}
            disabled={!billingValid || invoiceSubmitting}
            className="btn"
            style={{ width: '100%', justifyContent: 'center', padding: 14, fontSize: 15 }}
          >
            {invoiceSubmitting ? 'Issuing quote…' : 'Send PO quote for ' + formatGBP(amountDue)}
          </button>
        </div>
      )}

      {!payment && !isPO && paymentChoice === 'invoice' && invoiceConfirmed && (
        <div style={{ background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 20 }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 600 }}>Invoice sent</h4>
          <p style={{ fontSize: 13, color: BRAND.muted, margin: 0, lineHeight: 1.5 }}>
            We've issued an invoice for {formatGBP(amountDue)} to {billing.accountsEmail || signed.email}. Please check your inbox — payment terms are 14 days.
          </p>
        </div>
      )}

      {!payment && !isPO && paymentChoice === 'invoice' && !invoiceConfirmed && (
        <div ref={invoicePanelRef} style={{ background: 'white', border: '2px solid ' + BRAND.blue, borderRadius: 12, padding: 24, scrollMarginTop: 80 }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700 }}>Where shall we send your invoice?</h3>
          <p style={{ fontSize: 14, color: BRAND.muted, marginTop: 6, marginBottom: 16, lineHeight: 1.5 }}>
            Confirm your billing details and we'll issue an invoice for {formatGBP(amountDue)} straight away.
          </p>
          <div style={{
            borderRadius: 12,
            transition: 'box-shadow 0.6s ease',
            boxShadow: highlightBilling ? '0 0 0 4px rgba(43, 184, 230, 0.55)' : '0 0 0 0 rgba(43, 184, 230, 0)',
          }}>
            <BillingFields
              value={billing}
              onChange={setBilling}
              subtitle="The invoice will be sent to this address from our Xero account."
            />
          </div>
          <button
            onClick={submitInvoice}
            disabled={!billingValid || invoiceSubmitting}
            className="btn"
            style={{ width: '100%', justifyContent: 'center', padding: 14, fontSize: 15 }}
          >
            {invoiceSubmitting ? 'Issuing invoice…' : 'Issue invoice for ' + formatGBP(amountDue)}
          </button>
          <button onClick={onUndoInvoice} className="btn-ghost" style={{ marginTop: 12, fontSize: 12, width: '100%', textAlign: 'center' }}>
            Changed your mind? Pay now instead
          </button>
        </div>
      )}

      {!payment && !isPO && paymentChoice !== 'invoice' && (
        <div style={{ background: 'white', border: '2px solid ' + BRAND.blue, borderRadius: 12, padding: 24 }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700 }}>
            Would you like to pay your {isDeposit ? 'deposit' : 'invoice'} now?
          </h3>
          <p style={{ fontSize: 14, color: BRAND.muted, marginTop: 6, marginBottom: 16, lineHeight: 1.5 }}>
            {isDeposit
              ? 'Pay your 50% deposit of ' + formatGBP(amountDue) + ' now to start production immediately.'
              : signed.partnerSelected
                ? 'Pay the full amount of ' + formatGBP(amountDue) + ' now to start production and activate your Partner Programme.'
                : 'Pay the full amount of ' + formatGBP(amountDue) + ' now to lock in your free subtitled version.'}
          </p>

          <div style={{ background: BRAND.paper, borderRadius: 8, padding: 14, marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 12, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>Amount due now</div>
              <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>{formatGBP(amountDue)}</div>
            </div>
            <div style={{ fontSize: 11, color: BRAND.muted, textAlign: 'right' }}>
              Secure payment by<br />
              <strong style={{ color: BRAND.ink, fontSize: 13 }}>Stripe</strong>
            </div>
          </div>

          <BillingFields
            value={billing}
            onChange={setBilling}
            subtitle="We'll issue your invoice to this contact in Xero once payment is taken."
          />

          <button
            onClick={() => onPayNow({ billing })}
            disabled={paymentChoice === 'processing' || !billingValid}
            className="btn"
            style={{ width: '100%', justifyContent: 'center', padding: 14, fontSize: 15 }}
          >
            {paymentChoice === 'processing' ? 'Connecting…' : 'Pay ' + formatGBP(amountDue) + ' now by card'}
          </button>

          <button onClick={onChooseInvoice} style={{ background: 'none', border: 'none', color: BRAND.muted, cursor: 'pointer', fontSize: 13, marginTop: 12, width: '100%', textAlign: 'center', padding: 8 }}>
            Skip - send me an invoice instead
          </button>
        </div>
      )}
    </div>
  );
}
