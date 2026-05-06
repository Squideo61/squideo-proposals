// Kicks off Stripe Checkout for a signed proposal. Resolves never (redirects)
// or rejects with an Error if the session couldn't be created.
export async function startStripeCheckout({ proposalId, signed, billing }) {
  const partnerCtx = signed.partnerSelected && signed.amountBreakdown ? {
    projectExVat: signed.amountBreakdown.projectExVat,
    partnerExVat: signed.amountBreakdown.partnerExVat,
    partnerCredits: signed.amountBreakdown.partnerCredits,
    vatRate: signed.amountBreakdown.vatRate,
  } : null;
  const r = await fetch('/api/stripe/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proposalId,
      amount: signed.paymentOption === '5050' ? signed.total / 2 : signed.total,
      isDeposit: signed.paymentOption === '5050',
      customerEmail: signed.email,
      partner: partnerCtx,
      billing: billing || null,
    }),
  });
  let payload = {};
  try { payload = await r.json(); } catch {}
  if (!r.ok || !payload.url) throw new Error(payload.error || ('Checkout failed (HTTP ' + r.status + ')'));
  window.location.href = payload.url;
}
