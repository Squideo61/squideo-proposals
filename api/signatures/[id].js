import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';
import { getRole } from '../_lib/userRoles.js';
import { hasPermission } from '../_lib/permissions.js';
import { sendMail, signedHtml, clientSignedThanksHtml, APP_URL } from '../_lib/email.js';
import { sendNotification } from '../_lib/notifications.js';
import { advanceStage, regressStage, dealIdForProposal, ensureDealForProposal, logDealEvent } from '../_lib/dealStage.js';
import { computeProposalTotalExVat } from '../_lib/crm/deals.js';
import { voidInvoice } from '../_lib/xero.js';
import { sendPortalWelcome } from '../_lib/portal/onboarding.js';

// Allowlist of fields from `signatures.data` that the public client view
// actually consumes (SignedBlock, ClientView post-sign branch, ThankYouView,
// printProposal/Receipt, stripeCheckout). The full `data` JSONB is auth-only —
// anything else stays server-side. Update explicitly as the client viewer
// gains new signature-derived fields.
const PUBLIC_SIGNATURE_FIELDS = [
  'paymentOption', 'total', 'partnerSelected', 'partnerCredits',
  'partnerTotal', 'amountBreakdown',
  'selectedExtras', 'selectedVideoOption',
  // The drawn/uploaded signature image (PNG data URL) shown on the signed
  // confirmation + PDF.
  'signatureImage',
];

function publicSignatureView(data) {
  const src = data || {};
  const out = {};
  for (const k of PUBLIC_SIGNATURE_FIELDS) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;

  if (req.method === 'DELETE') {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!hasPermission(await getRole(user.role), 'signatures.manage_all')) {
      return res.status(403).json({ error: 'You do not have permission to clear signatures' });
    }

    // If we previously issued a Xero invoice for this proposal (email-invoice
    // route), void it so it no longer counts and clear the stored reference.
    // The next sign on the same link will then create a fresh invoice from
    // the new client selection. Best-effort: a Xero failure (e.g. already
    // PAID) must not block the unmark — log and continue.
    const billing = await sql`
      SELECT xero_invoice_id, xero_quote_id FROM proposal_billing WHERE proposal_id = ${id}
    `;
    const oldInvoiceId = billing[0]?.xero_invoice_id || null;
    if (oldInvoiceId) {
      try { await voidInvoice(oldInvoiceId); }
      catch (err) { console.error('[signatures] voidInvoice failed', err.message || err); }
    }
    if (billing.length) {
      await sql`
        UPDATE proposal_billing
           SET xero_invoice_id = NULL, xero_quote_id = NULL, updated_at = NOW()
         WHERE proposal_id = ${id}
      `;
    }

    await sql`DELETE FROM signatures WHERE proposal_id = ${id}`;

    // CRM: regress the linked deal from 'signed' back to 'proposal_sent' so
    // the pipeline reflects that we're awaiting a fresh view/sign cycle. The
    // next view event will naturally re-advance it to 'viewed' via the views
    // route. Strictly gated on current stage = 'signed' so a deal that's
    // already moved to 'paid' isn't dragged backwards. Also revert deals.value
    // back to the proposal's basePrice — at sign time we replaced it with the
    // signed total ex-VAT, so on unmark we restore the pre-sign baseline.
    // Best-effort.
    try {
      const dealId = await dealIdForProposal(id);
      if (dealId) {
        await regressStage(dealId, 'signed', 'proposal_sent', {
          actorEmail: user.email || null,
          reason: 'signature-unmarked',
          payload: { proposalId: id },
        });
        const proposalRows = await sql`SELECT data FROM proposals WHERE id = ${id}`;
        const basePrice = proposalRows[0]?.data?.basePrice;
        if (basePrice != null && Number.isFinite(Number(basePrice))) {
          await sql`
            UPDATE deals
               SET value = ${Number(basePrice)}, updated_at = NOW()
             WHERE id = ${dealId}
          `;
        }
      }
    } catch (err) {
      console.error('[signatures] regressStage / value revert failed', err);
    }

    return res.status(200).json({ ok: true, voidedInvoiceId: oldInvoiceId });
  }

  if (req.method === 'PATCH') {
    // Change the payment plan (50/50 ↔ full ↔ PO) on an ALREADY-SIGNED
    // proposal, WITHOUT forcing a re-sign. `signatures.data.paymentOption` is
    // the single source of truth every pricing/finance path reads (Stripe
    // checkout amount, saleStatus deposit/paid pills, Pending Payments split,
    // deferred-revenue figure), so rewriting it here is all that's needed for
    // the CRM to expect the new plan. Used when a client who signed a 50/50
    // deal decides to pay in full (and vice-versa). Admin/signature-manager
    // only, like the DELETE below.
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!hasPermission(await getRole(user.role), 'signatures.manage_all')) {
      return res.status(403).json({ error: 'You do not have permission to change payment terms' });
    }

    const paymentOption = req.body?.paymentOption;
    const VALID = ['5050', 'full', 'po'];
    if (!VALID.includes(paymentOption)) {
      return res.status(400).json({ error: 'Invalid payment option — expected one of 5050, full, po.' });
    }

    const existing = await sql`SELECT data FROM signatures WHERE proposal_id = ${id}`;
    if (!existing.length) {
      return res.status(404).json({ error: 'This proposal has not been signed yet, so there is no payment plan to change.' });
    }
    const current = existing[0].data?.paymentOption || 'full';
    if (current === paymentOption) {
      return res.status(200).json({ ok: true, paymentOption, unchanged: true });
    }

    // Guard: if a payment has already been captured against this proposal, a
    // plan change would desync what's owed from what "Pay now" charges — a
    // 'full' checkout re-charges the whole total and does NOT subtract a
    // deposit already paid, so we'd double-charge. Once money has moved, the
    // remaining balance is collected via the Finance / Pending Payments flow,
    // not by flipping the plan here.
    const [{ n: paidCount }] = await sql`SELECT COUNT(*)::int AS n FROM payments WHERE proposal_id = ${id}`;
    if (paidCount > 0) {
      return res.status(409).json({
        error: 'A payment has already been recorded on this proposal, so the plan can’t be switched automatically. Collect any remaining balance from the Finance → Pending Payments flow instead.',
      });
    }

    await sql`
      UPDATE signatures
         SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{paymentOption}', ${JSON.stringify(paymentOption)}::jsonb)
       WHERE proposal_id = ${id}
    `;

    // Keep the (cosmetic) production-board "Payment" column in step, and leave
    // an audit trail on the deal. Best-effort — the pricing-authority write
    // above has already succeeded, so a board/log hiccup must not fail the call.
    const boardTerms = paymentOption === '5050' ? '50_50' : paymentOption === 'po' ? 'po' : 'full_upfront';
    try {
      const dealId = await dealIdForProposal(id);
      if (dealId) {
        await sql`UPDATE deals SET payment_terms = ${boardTerms}, updated_at = NOW() WHERE id = ${dealId}`;
        await logDealEvent(dealId, 'payment_plan_changed', {
          actorEmail: user.email || null,
          payload: { proposalId: id, from: current, to: paymentOption },
        });
      }
    } catch (err) {
      console.error('[signatures] payment plan mirror/log failed', err.message || err);
    }

    return res.status(200).json({ ok: true, paymentOption });
  }

  if (req.method === 'GET') {
    const rows = await sql`SELECT name, email, signed_at, data FROM signatures WHERE proposal_id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const row = rows[0];
    return res.status(200).json({
      name: row.name,
      email: row.email,
      signedAt: row.signed_at,
      ...publicSignatureView(row.data),
    });
  }

  if (req.method === 'POST') {
    // Reject replay/overwrite: once signed, the only way to re-sign is for the
    // team to clear the signature via the auth-required DELETE above (the
    // dashboard's "Unmark as accepted" action).
    const existing = await sql`SELECT 1 FROM signatures WHERE proposal_id = ${id} LIMIT 1`;
    if (existing.length > 0) {
      return res.status(409).json({ error: 'This proposal has already been signed.' });
    }

    const { name, email, signedAt, ...rest } = req.body;
    await sql`
      INSERT INTO signatures (proposal_id, name, email, signed_at, data)
      VALUES (${id}, ${name}, ${email}, ${signedAt}, ${JSON.stringify(rest)})
    `;

    // CRM: advance the linked deal to 'signed' AND sync deals.value to the
    // signed ex-VAT total (which reflects selected extras / partner discount,
    // unlike the proposal's basePrice that we sync on every save). Excludes
    // the recurring partner-programme subscription — that's separate revenue.
    // Best-effort: don't break the sign flow on a deal-side failure.
    let dealId = null;
    try {
      // Guarantee a deal exists for the signed proposal — if the save-time
      // auto-create never ran, this creates the deal card now.
      dealId = await ensureDealForProposal(id);
      if (dealId) {
        await advanceStage(dealId, 'signed', { payload: { proposalId: id, signerName: name, signerEmail: email } });
        const proposalRows = await sql`SELECT data FROM proposals WHERE id = ${id}`;
        const proposalData = proposalRows[0]?.data || {};
        const signedValue = computeProposalTotalExVat(proposalData, rest);
        if (signedValue != null && Number.isFinite(Number(signedValue))) {
          await sql`
            UPDATE deals
               SET value = ${Number(signedValue)}, updated_at = NOW()
             WHERE id = ${dealId}
          `;
        }
      }
    } catch (err) {
      console.error('[signatures] advanceStage / value sync failed', err);
    }

    try {
      const proposals = await sql`SELECT data FROM proposals WHERE id = ${id}`;
      const proposal = proposals[0]?.data || {};
      const title = proposal.proposalTitle || proposal.clientName || id;
      const link = `${APP_URL}/?proposal=${id}`;
      await sendNotification('proposal.signed', {
        subject: `🎉 Signed: ${title}`,
        html: signedHtml({ proposal, signature: rest, signerName: name, signerEmail: email, signedAt, link }),
        text: `${name || 'Someone'} (${email || ''}) signed "${title}" on ${signedAt}. ${link}`,
        // Bell click deep-links to the deal/project page (in-app hash route,
        // distinct from the absolute APP_URL link used in the email).
        inApp: dealId ? { link: `#/deal/${dealId}` } : null,
      });

      if (email) {
        const signedProposalLink = `${APP_URL}/?proposal=${id}&thanks=1&download=signed`;
        const payNowLink = rest.paymentOption !== 'po' ? `${APP_URL}/?proposal=${id}&thanks=1` : null;
        await sendMail({
          to: email,
          subject: `Thanks for signing - ${title}`,
          html: clientSignedThanksHtml({ proposal, clientName: name, signedProposalLink, payNowLink }),
          text: `Thanks${name ? ', ' + name : ''}! We've got your signed proposal for "${title}". Download it here: ${signedProposalLink}${payNowLink ? '. Pay now: ' + payNowLink : ''}`,
        });
      }
    } catch (err) {
      console.error('[signatures] broadcast email failed', err);
    }

    // Customer portal: invite the signer to set up their (org-scoped) portal
    // account, with details prefilled from the contact/signature. Best-effort —
    // a portal hiccup must never break signing; the CRM has a "Resend portal
    // invite" action as the recovery path.
    try {
      if (dealId && email) {
        const proposals = await sql`SELECT data FROM proposals WHERE id = ${id}`;
        await sendPortalWelcome({
          dealId,
          proposalData: proposals[0]?.data || {},
          signerName: name,
          signerEmail: email,
        });
      }
    } catch (err) {
      console.error('[signatures] portal welcome failed', err);
    }

    return res.status(201).json({ ok: true });
  }

  res.status(405).end();
}
