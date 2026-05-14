import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';
import { sendMail, signedHtml, clientSignedThanksHtml, APP_URL } from '../_lib/email.js';
import { advanceStage, dealIdForProposal } from '../_lib/dealStage.js';
import { voidInvoice } from '../_lib/xero.js';

// Allowlist of fields from `signatures.data` that the public client view
// actually consumes (SignedBlock, ClientView post-sign branch, ThankYouView,
// printProposal/Receipt, stripeCheckout). The full `data` JSONB is auth-only —
// anything else stays server-side. Update explicitly as the client viewer
// gains new signature-derived fields.
const PUBLIC_SIGNATURE_FIELDS = [
  'paymentOption', 'total', 'partnerSelected', 'partnerCredits',
  'partnerTotal', 'amountBreakdown',
  'selectedExtras', 'selectedVideoOption',
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
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

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
    return res.status(200).json({ ok: true, voidedInvoiceId: oldInvoiceId });
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

    // CRM: advance the linked deal to 'signed'. Best-effort.
    try {
      const dealId = await dealIdForProposal(id);
      if (dealId) {
        await advanceStage(dealId, 'signed', { payload: { proposalId: id, signerName: name, signerEmail: email } });
      }
    } catch (err) {
      console.error('[signatures] advanceStage failed', err);
    }

    try {
      const [users, proposals] = await Promise.all([
        sql`SELECT email FROM users`,
        sql`SELECT data FROM proposals WHERE id = ${id}`,
      ]);
      const proposal = proposals[0]?.data || {};
      const recipients = users.map(u => u.email).filter(Boolean);
      const title = proposal.proposalTitle || proposal.clientName || id;
      const link = `${APP_URL}/?proposal=${id}`;
      if (recipients.length) {
        await sendMail({
          to: recipients,
          subject: `🎉 Signed: ${title}`,
          html: signedHtml({ proposal, signature: rest, signerName: name, signerEmail: email, signedAt, link }),
          text: `${name || 'Someone'} (${email || ''}) signed "${title}" on ${signedAt}. ${link}`,
        });
      }

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

    return res.status(201).json({ ok: true });
  }

  res.status(405).end();
}
