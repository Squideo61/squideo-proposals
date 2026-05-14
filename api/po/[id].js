import sql from '../_lib/db.js';
import { cors } from '../_lib/middleware.js';
import { sendMail, APP_URL } from '../_lib/email.js';
import { getOrCreateContact, createQuote } from '../_lib/xero.js';
import { xeroContactIdForProposal } from '../_lib/dealStage.js';
import {
  lineItemsForProject,
  lineItemsForDiscountedProject,
  lineItemsForPartnerFirstMonth,
  formatProposalNumber,
} from '../_lib/xeroMappers.js';

function billingToContact(billing, fallbackEmail) {
  return {
    name: billing.companyName?.trim(),
    email: billing.accountsEmail?.trim() || fallbackEmail || undefined,
    vatNumber: billing.vatNumber?.trim() || undefined,
    address: {
      line1: billing.addressLine1 || '',
      line2: billing.addressLine2 || '',
      city: billing.city || '',
      postcode: billing.postcode || '',
      country: billing.country || 'United Kingdom',
    },
  };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { id: proposalId } = req.query;
  const { billing } = req.body || {};

  if (!proposalId) return res.status(400).json({ error: 'proposalId required' });
  if (!billing?.companyName?.trim() || !billing?.addressLine1?.trim() || !billing?.accountsEmail?.trim()) {
    return res.status(400).json({ error: 'billing.companyName, addressLine1 and accountsEmail are required' });
  }

  const [proposalRows, sigRows] = await Promise.all([
    sql`SELECT data, number_year, number_seq FROM proposals WHERE id = ${proposalId}`,
    sql`SELECT name, email, data FROM signatures WHERE proposal_id = ${proposalId}`,
  ]);
  const proposalRow = proposalRows[0];
  const proposal = proposalRow?.data;
  const proposalNumber = formatProposalNumber(proposalRow?.number_year, proposalRow?.number_seq);
  const sigRow = sigRows[0];

  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
  if (!sigRow) return res.status(409).json({ error: 'Proposal must be signed first' });

  const signed = { name: sigRow.name, email: sigRow.email, ...(sigRow.data || {}) };
  if (signed.paymentOption !== 'po') {
    return res.status(409).json({ error: 'Proposal is not on the PO route' });
  }

  await sql`
    INSERT INTO proposal_billing (proposal_id, billing)
    VALUES (${proposalId}, ${JSON.stringify(billing)})
    ON CONFLICT (proposal_id) DO UPDATE
      SET billing = EXCLUDED.billing, updated_at = NOW()
  `;

  const [existing] = await sql`SELECT xero_quote_id FROM proposal_billing WHERE proposal_id = ${proposalId}`;
  if (existing?.xero_quote_id) {
    return res.status(200).json({ ok: true, quoteId: existing.xero_quote_id, deduped: true });
  }

  let quoteId;
  try {
    const linkedXeroContactId = await xeroContactIdForProposal(proposalId);
    const contactId = await getOrCreateContact({
      ...billingToContact(billing, signed.email),
      xeroContactId: linkedXeroContactId || undefined,
    });

    const isPartner = !!signed.partnerSelected && !!signed.amountBreakdown;
    const lineItems = isPartner
      ? [
          ...lineItemsForDiscountedProject(proposal, signed, proposalNumber),
          ...lineItemsForPartnerFirstMonth(proposal, signed, proposalNumber),
        ]
      : lineItemsForProject(proposal, signed, proposalNumber);

    const referenceBase = proposalNumber || (proposal.proposalTitle || proposal.clientName || proposalId);
    quoteId = await createQuote({
      contactId,
      lineItems,
      reference: `${referenceBase} — Pending PO`.slice(0, 80),
      status: 'SENT',
    });

    await sql`UPDATE proposal_billing SET xero_quote_id = ${quoteId} WHERE proposal_id = ${proposalId}`;
  } catch (err) {
    console.error('[po] Xero quote creation failed', err);
    return res.status(502).json({ error: 'Could not create quote: ' + (err.message || 'unknown') });
  }

  try {
    const users = await sql`SELECT email FROM users`;
    const recipients = users.map(u => u.email).filter(Boolean);
    const ownerEmail = proposal.preparedByEmail || null;
    const to = ownerEmail ? [ownerEmail, ...recipients.filter(e => e !== ownerEmail)] : recipients;
    const title = proposal.proposalTitle || proposal.clientName || proposalId;
    const link = `${APP_URL}/?proposal=${proposalId}`;
    if (to.length) {
      await sendMail({
        to,
        subject: `📋 PO route confirmed: ${title}`,
        html: `<p>${signed.name || 'A client'} (${signed.email || ''}) confirmed the Purchase Order route for <strong>${title}</strong>.</p>
               <p>Billing company: <strong>${billing.companyName}</strong></p>
               <p>A Xero quote (reference: Pending PO) has been issued and sent to ${billing.accountsEmail}.</p>
               <p><a href="${link}">Open the proposal</a></p>`,
        text: `${signed.name || 'A client'} confirmed PO route for "${title}". Xero quote issued. ${link}`,
      });
    }
  } catch (err) {
    console.error('[po] notification email failed', err);
  }

  return res.status(200).json({ ok: true, quoteId });
}
