import sql from '../_lib/db.js';
import { cors } from '../_lib/middleware.js';
import { sendMail, APP_URL } from '../_lib/email.js';
import { getOrCreateContact, createQuote } from '../_lib/xero.js';
import { lineItemsForProject, lineItemsForDiscountedProject, lineItemsForPartnerFirstMonth } from '../_lib/xeroMappers.js';

function billingToContact(billing, fallbackEmail) {
  if (!billing) return null;
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

  const { id } = req.query;
  const { billing } = req.body || {};

  if (!billing?.companyName?.trim() || !billing?.addressLine1?.trim() || !billing?.accountsEmail?.trim()) {
    return res.status(400).json({ error: 'billing.companyName, addressLine1 and accountsEmail are required' });
  }

  const [proposalRows, sigRows] = await Promise.all([
    sql`SELECT data FROM proposals WHERE id = ${id}`,
    sql`SELECT name, email, data FROM signatures WHERE proposal_id = ${id}`,
  ]);
  const proposal = proposalRows[0]?.data;
  const sigRow = sigRows[0];
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
  if (!sigRow) return res.status(409).json({ error: 'Proposal must be signed first' });

  const signed = { name: sigRow.name, email: sigRow.email, ...(sigRow.data || {}) };
  if (signed.paymentOption !== 'po') {
    return res.status(409).json({ error: 'Proposal payment option is not PO' });
  }

  // Persist billing for parity with the Stripe path (so the dashboard and any
  // future invoice-from-PO conversion can read it).
  await sql`
    INSERT INTO proposal_billing (proposal_id, billing)
    VALUES (${id}, ${JSON.stringify(billing)})
    ON CONFLICT (proposal_id) DO UPDATE
      SET billing = EXCLUDED.billing, updated_at = NOW()
  `;

  // Idempotency: if we already created a quote for this proposal, return it
  // rather than minting a duplicate.
  const [existing] = await sql`SELECT xero_quote_id FROM payments WHERE proposal_id = ${id}`;
  if (existing?.xero_quote_id) {
    return res.status(200).json({ ok: true, quoteId: existing.xero_quote_id, deduped: true });
  }

  let quoteId;
  try {
    const contactId = await getOrCreateContact(billingToContact(billing, signed.email));

    let lineItems;
    if (signed.partnerSelected && signed.amountBreakdown) {
      lineItems = [
        ...lineItemsForDiscountedProject(proposal, signed),
        ...lineItemsForPartnerFirstMonth(proposal, signed),
      ];
    } else {
      lineItems = lineItemsForProject(proposal, signed);
    }

    const expiry = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    quoteId = await createQuote({
      contactId,
      lineItems,
      reference: 'Pending PO',
      status: 'SENT',
      expiryDate: expiry,
    });

    // Persist the quote ID. payments may not have a row yet (PO route never
    // hits Stripe), so we INSERT a placeholder row carrying just the quote.
    // The existing payments table requires amount/payment_type/paid_at to
    // exist on insert; we use 0/'po'/NOW() as a sentinel.
    await sql`
      INSERT INTO payments (proposal_id, amount, payment_type, paid_at, stripe_session_id, customer_email, xero_quote_id)
      VALUES (${id}, 0, 'po', NOW(), ${'po-' + id}, ${billing.accountsEmail || signed.email || null}, ${quoteId})
      ON CONFLICT (proposal_id) DO UPDATE
        SET xero_quote_id = EXCLUDED.xero_quote_id
    `;
  } catch (err) {
    console.error('[po] xero quote creation failed', err);
    return res.status(502).json({ error: 'Could not create quote: ' + (err.message || 'unknown') });
  }

  // Best-effort team notification — failure must not affect the API response
  // since the Xero quote was already created successfully.
  try {
    const users = await sql`SELECT email FROM users`;
    const recipients = users.map(u => u.email).filter(Boolean);
    const ownerEmail = proposal.preparedByEmail || null;
    const to = ownerEmail ? [ownerEmail, ...recipients.filter(e => e !== ownerEmail)] : recipients;
    const title = proposal.proposalTitle || proposal.clientName || id;
    const link = `${APP_URL}/?proposal=${id}`;
    if (to.length) {
      await sendMail({
        to,
        subject: `📄 PO quote sent: ${title}`,
        html: `<p>${signed.name || 'A client'} (${signed.email || ''}) confirmed PO route for <strong>${title}</strong>.</p>
               <p>Billing company: <strong>${billing.companyName}</strong> (${billing.accountsEmail || ''})</p>
               <p>A formal quote with reference <em>Pending PO</em> has been issued from Xero.</p>
               <p><a href="${link}">Open the proposal</a></p>`,
        text: `${signed.name || 'A client'} confirmed PO route for "${title}". Quote sent. ${link}`,
      });
    }
  } catch (err) {
    console.error('[po] notification email failed', err);
  }

  return res.status(200).json({ ok: true, quoteId });
}
