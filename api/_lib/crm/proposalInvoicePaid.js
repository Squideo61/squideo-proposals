// "The client paid the invoice we raised for their proposal."
//
// This was the one way money could arrive without anybody being told. A signed
// client who clicks "Send me an invoice instead" leaves the card path: the
// invoice is raised in Xero, they pay it — often from the pay-by-card link on
// the invoice itself — and the money lands in Xero, never in our `payments`
// table. Everything downstream still worked (the deal advanced to 'paid', the
// "Deposit paid" pill appeared, the balance was right) so nothing looked
// broken. It just happened in silence, and the first anyone knew was noticing
// the pill days later.
//
// Two callers, because there are two ways we find out and either can be first:
//   · the Xero webhook, when Xero pushes the PAID event
//   · the invoices sync, which stamps proposal_billing.paid_amount whenever
//     someone opens the invoices page
//
// Hence the claim. `paid_notified_at` is taken in a single conditional UPDATE,
// so whichever caller gets there first sends and every later one — a Xero
// retry, a second page load, both racing — gets no row back and stays quiet.

import sql from '../db.js';
import { APP_URL } from '../email.js';
import { sendNotification } from '../notifications.js';
import { dealIdForProposal } from '../dealStage.js';

const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

let ensured = null;
// Best-effort like every other ensure*(): a failure here must never break the
// webhook or the invoices page. See db/migrations/20260822_invoice_paid_notify.sql.
export function ensurePaidNotifyColumn() {
  if (ensured) return ensured;
  ensured = (async () => {
    try {
      await sql`ALTER TABLE proposal_billing ADD COLUMN IF NOT EXISTS paid_notified_at TIMESTAMPTZ`;
    } catch (err) {
      console.warn('[invoicePaid] ensure failed', err.message);
    }
  })();
  return ensured;
}

const money = (n) => (n == null ? null : `£${Number(n).toFixed(2)}`);

// Claim + notify. Returns true when this call is the one that sent.
//
// `amount` is the invoice total (inc VAT) as Xero has it; null is fine, the
// alert just doesn't quote a figure rather than quoting a wrong one.
export async function notifyProposalInvoicePaid({
  xeroInvoiceId, invoiceNumber = null, amount = null, paidAt = null, source = 'xero',
}) {
  if (!xeroInvoiceId) return false;
  await ensurePaidNotifyColumn();

  let claimed;
  try {
    // Only a proposal-billing invoice can be claimed here, and only once.
    // Manual invoices have their own paid alert (invoice.paid_manual) and
    // aren't in this table, so they can't be double-announced.
    claimed = await sql`
      UPDATE proposal_billing
         SET paid_notified_at = NOW()
       WHERE xero_invoice_id = ${xeroInvoiceId}
         AND paid_notified_at IS NULL
      RETURNING proposal_id`;
  } catch (err) {
    console.warn('[invoicePaid] claim failed', err.message);
    return false;
  }
  if (!claimed.length) return false;

  const proposalId = claimed[0].proposal_id;
  try {
    const [[proposalRow], dealId] = await Promise.all([
      sql`SELECT data FROM proposals WHERE id = ${proposalId}`.catch(() => []),
      dealIdForProposal(proposalId).catch(() => null),
    ]);
    const proposal = proposalRow?.data || {};
    const title = proposal.proposalTitle || proposal.clientName || proposalId;
    const ref = invoiceNumber || xeroInvoiceId;
    const link = dealId ? `${APP_URL}/#/deal/${dealId}` : `${APP_URL}/?proposal=${proposalId}`;
    const sum = money(amount);

    // Same key as a card payment: from the money side of the business this IS
    // the client paying, and routing it anywhere else would mean the £ bell
    // tells you about some payments and not others depending on which button
    // the client happened to press.
    await sendNotification('payment.received', {
      subject: `💰 Invoice paid: ${title}`,
      html: `<p>The client paid invoice <strong>${escapeHtml(ref)}</strong> for <strong>${escapeHtml(title)}</strong>${sum ? ` — <strong>${escapeHtml(sum)}</strong>` : ''}.</p>
             <p>They took the "send me an invoice" route rather than paying by card, so this came in through Xero.</p>
             <p style="margin:16px 0;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Open the deal</a></p>`,
      text: `Invoice ${ref} paid${sum ? ` (${sum})` : ''} for "${title}" — via Xero. ${link}`,
      inApp: {
        title: `Invoice paid: ${title}`,
        body: `${ref}${sum ? ` · ${sum}` : ''} paid via Xero`,
        link: dealId ? `#/deal/${dealId}` : null,
      },
    });
    return true;
  } catch (err) {
    // The claim is already taken, so this won't retry. That's the deliberate
    // trade: a notification we failed to send is a smaller problem than the
    // same one arriving every time somebody opens the invoices page.
    console.error('[invoicePaid] notify failed', err);
    return false;
  }
}
