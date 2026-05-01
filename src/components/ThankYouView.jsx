import React, { useEffect, useRef, useState } from 'react';
import { Check, CreditCard, Download, FileText, Phone } from 'lucide-react';
import { BRAND, CONFIG } from '../theme.js';
import { NEXT_STEPS } from '../defaults.js';
import { formatGBP } from '../utils.js';
import { openPrintWindow, openReceiptWindow, printOptionsForSigned } from '../utils/printProposal.js';
import { startStripeCheckout } from '../utils/stripeCheckout.js';
import { Logo } from './ui.jsx';

export function ThankYouView({ proposalId, proposal, signed, payment, onViewProposal, useRealStripe = true, showMsg }) {
  const autoPrintFiredRef = useRef(false);
  const [paymentChoice, setPaymentChoice] = useState(null); // null | 'invoice' | 'processing'

  // Auto-fire print when arriving via the email's "Download signed proposal"
  // CTA. Strip the flag so a refresh doesn't re-trigger it.
  useEffect(() => {
    if (autoPrintFiredRef.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('download') !== 'signed') return;
    if (!signed) return;
    autoPrintFiredRef.current = true;
    openPrintWindow(proposal, printOptionsForSigned(signed, payment));
    params.delete('download');
    const url = new URL(window.location.href);
    url.search = params.toString();
    window.history.replaceState({}, '', url.toString());
  }, [signed, payment, proposal]);

  if (!proposal) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: BRAND.muted }}>
        Loading…
      </div>
    );
  }

  const title = proposal.proposalTitle || proposal.clientName || 'your proposal';
  const clientName = signed?.name || proposal.clientName;
  const totalExVat = proposal.vatRate && signed?.total ? signed.total / (1 + proposal.vatRate) : signed?.total;
  const isPO = signed?.paymentOption === 'po';
  const isDeposit = signed?.paymentOption === '5050';
  const amountDue = signed ? (isDeposit ? signed.total / 2 : signed.total) : 0;
  const showPaymentPanel = signed && !payment && !isPO;

  const downloadSigned = () => {
    if (!signed) return;
    openPrintWindow(proposal, printOptionsForSigned(signed, payment));
  };

  const downloadReceipt = () => {
    if (!signed || !payment) return;
    openReceiptWindow(proposal, signed, payment);
  };

  const handlePayNow = async () => {
    if (!useRealStripe) {
      showMsg && showMsg('Payments are disabled in preview mode');
      return;
    }
    setPaymentChoice('processing');
    try {
      await startStripeCheckout({ proposalId, signed });
    } catch (err) {
      console.error('[stripe checkout]', err);
      setPaymentChoice(null);
      showMsg && showMsg(err?.message ? 'Checkout error: ' + err.message : 'Could not start checkout. Please try again.');
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: BRAND.paper, padding: '40px 20px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 24 }}>
          <Logo size={48} />
        </div>

        <div style={{
          background: 'white',
          border: '1px solid ' + BRAND.border,
          borderTop: '4px solid #16A34A',
          borderRadius: 12,
          padding: '32px 28px',
          textAlign: 'center',
          marginBottom: 20,
          boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
        }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%', background: '#E8F5E9',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 18px',
          }}>
            <Check size={32} color="#16A34A" strokeWidth={2.5} />
          </div>
          <h1 style={{ margin: '0 0 8px', fontSize: 24, fontWeight: 700, color: BRAND.ink }}>
            {payment ? 'Payment received' : 'Thanks for signing'}{clientName ? `, ${clientName}` : ''}!
          </h1>
          <p style={{ margin: 0, fontSize: 15, color: BRAND.muted, lineHeight: 1.55 }}>
            We've got your acceptance for <strong style={{ color: BRAND.ink }}>{title}</strong>.
            {payment ? ' Production will be scheduled shortly.' : " We'll be in touch with the next steps shortly."}
          </p>
        </div>

        <div style={{
          background: 'white',
          border: '1px solid ' + BRAND.border,
          borderRadius: 12,
          padding: '20px 24px',
          marginBottom: 20,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 12 }}>Your copy</div>

          {signed && (
            <div style={{ fontSize: 13, color: BRAND.muted, marginBottom: 14, lineHeight: 1.6 }}>
              <div>Signed by <strong style={{ color: BRAND.ink }}>{signed.name}</strong> ({signed.email})</div>
              <div>On {new Date(signed.signedAt).toLocaleString('en-GB')}</div>
              {totalExVat ? <div>Committed total: <strong style={{ color: BRAND.ink }}>{formatGBP(totalExVat)} + VAT</strong></div> : null}
              {payment && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid ' + BRAND.border }}>
                  Paid <strong style={{ color: BRAND.ink }}>{formatGBP(payment.amount)}</strong>
                  {' '}{payment.paymentType === 'deposit' ? '(50% deposit)' : '(full payment)'} on {new Date(payment.paidAt).toLocaleString('en-GB')}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <button onClick={downloadSigned} className="btn" style={{ flex: '1 1 220px', justifyContent: 'center', padding: '12px 18px', fontSize: 14, background: '#16A34A' }}>
              <FileText size={16} /> Download signed proposal
            </button>
            {payment && (
              <button onClick={downloadReceipt} className="btn" style={{ flex: '1 1 220px', justifyContent: 'center', padding: '12px 18px', fontSize: 14 }}>
                <Download size={16} /> Download receipt
              </button>
            )}
          </div>
        </div>

        {showPaymentPanel && paymentChoice !== 'invoice' && (
          <div style={{
            background: 'white',
            border: '2px solid ' + BRAND.blue,
            borderRadius: 12,
            padding: 24,
            marginBottom: 20,
          }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700 }}>
              Pay your {isDeposit ? 'deposit' : 'invoice'} now
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

            <button
              onClick={handlePayNow}
              disabled={paymentChoice === 'processing'}
              className="btn"
              style={{ width: '100%', justifyContent: 'center', padding: 14, fontSize: 15 }}
            >
              <CreditCard size={16} />
              {paymentChoice === 'processing' ? 'Connecting…' : 'Pay ' + formatGBP(amountDue) + ' now by card'}
            </button>

            <button
              onClick={() => setPaymentChoice('invoice')}
              style={{ background: 'none', border: 'none', color: BRAND.muted, cursor: 'pointer', fontSize: 13, marginTop: 12, width: '100%', textAlign: 'center', padding: 8 }}
            >
              Skip — send me an invoice instead
            </button>
          </div>
        )}

        {showPaymentPanel && paymentChoice === 'invoice' && (
          <div style={{ background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 20, marginBottom: 20 }}>
            <h4 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 600 }}>Invoice on its way</h4>
            <p style={{ fontSize: 13, color: BRAND.muted, margin: 0, lineHeight: 1.5 }}>
              We'll send an invoice for {formatGBP(amountDue)} to {signed.email} within 24 hours.
            </p>
            <button onClick={() => setPaymentChoice(null)} className="btn-ghost" style={{ marginTop: 12, fontSize: 12 }}>
              Changed your mind? Pay now instead
            </button>
          </div>
        )}

        {signed && !payment && isPO && (
          <div style={{ background: BRAND.paper, border: '1px solid ' + BRAND.border, borderRadius: 12, padding: 20, marginBottom: 20 }}>
            <h4 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 600 }}>Purchase Order confirmed</h4>
            <p style={{ fontSize: 13, color: BRAND.muted, margin: 0, lineHeight: 1.5 }}>
              Our team will be in touch within 24 hours to set up your supplier details and confirm the Purchase Order for {formatGBP(amountDue)}.
            </p>
          </div>
        )}

        <div style={{
          background: 'white',
          border: '1px solid ' + BRAND.border,
          borderRadius: 12,
          padding: '20px 24px',
          marginBottom: 20,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.muted, letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 14 }}>What happens next</div>
          {NEXT_STEPS.map((step, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, marginBottom: 12, fontSize: 14, lineHeight: 1.6 }}>
              <div style={{ width: 24, height: 24, borderRadius: '50%', background: BRAND.blue, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>
                {i + 1}
              </div>
              <span>{step}</span>
            </div>
          ))}
          {CONFIG?.company?.phone && (
            <p style={{ margin: '14px 0 0', fontSize: 14, lineHeight: 1.6 }}>
              Still got questions? Give us a call on{' '}
              <a href={`tel:${CONFIG.company.phone}`} style={{ color: BRAND.blue, fontWeight: 600 }}>
                <Phone size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                +44 (0){CONFIG.company.phone}
              </a>.
            </p>
          )}
        </div>

        <div style={{ textAlign: 'center', fontSize: 13, color: BRAND.muted }}>
          {onViewProposal && (
            <button onClick={onViewProposal} className="btn-link" style={{ fontSize: 13 }}>
              View your proposal
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

