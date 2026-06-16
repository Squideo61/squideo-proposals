// Xero webhook receiver. Xero POSTs an "events" payload whenever a watched
// resource changes (we subscribe to Invoices). We use it to auto-credit a
// partner subscription when its linked recurring invoice is paid — by card
// (Xero's Stripe "Pay now" link) or BACS, both of which flip the invoice to
// PAID in Xero.
//
// Setup (one-off, in the Xero developer portal → your app → Webhooks):
//   • Delivery URL: https://app.squideo.com/api/xero/webhook
//   • Subscribe to:  Invoices
//   • Copy the "Webhook signing key" into the XERO_WEBHOOK_KEY env var.
//   • Click "Send 'Intent to receive'" — this very handler answers the
//     handshake (200 on a valid signature, 401 otherwise).
//
// Security: every request (handshake and real events) carries an
// x-xero-signature header = base64(HMAC-SHA256(rawBody, signing key)). We
// recompute it over the raw bytes and reject anything that doesn't match.
import crypto from 'crypto';
import sql from '../_lib/db.js';
import { getInvoicesByIds } from '../_lib/xero.js';
import { sendNotification } from '../_lib/notifications.js';
import { APP_URL } from '../_lib/email.js';
import { advanceStage, dealIdForProposal } from '../_lib/dealStage.js';
import { markExtrasPaidForXeroInvoice } from '../_lib/crm/extras.js';
import { escapeHtml } from '../_lib/crm/shared.js';

// Raw body is required for signature verification — turn Vercel's parser off.
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);

  const signingKey = process.env.XERO_WEBHOOK_KEY;
  if (!signingKey) {
    console.error('[xero webhook] XERO_WEBHOOK_KEY not set');
    return res.status(500).end();
  }

  // Verify HMAC. Use a length-safe compare; mismatched lengths must not throw.
  const expected = crypto.createHmac('sha256', signingKey).update(rawBody).digest('base64');
  const got = String(req.headers['x-xero-signature'] || '');
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!valid) {
    // Both a forged event and a failed "Intent to receive" handshake land here.
    return res.status(401).end();
  }

  let payload = {};
  try { payload = JSON.parse(rawBody.toString() || '{}'); } catch { payload = {}; }
  const events = Array.isArray(payload.events) ? payload.events : [];

  // "Intent to receive" sends a signed payload with no events — a valid
  // signature is all Xero wants. Real deliveries carry one or more events.
  if (events.length === 0) return res.status(200).end();

  // Process before responding. Xero wants a 2xx within ~5s and retries on
  // failure; our work is one batched Xero read + a few idempotent DB writes,
  // comfortably inside that window. Retries are safe (source_ref dedupes).
  try {
    await processInvoiceEvents(events);
  } catch (err) {
    console.error('[xero webhook] processing failed', err);
    // Still 200 — a 500 makes Xero retry, and our writes are idempotent so a
    // retry is harmless, but repeated failures just spam. We've logged it.
  }
  return res.status(200).json({ received: true });
}

async function processInvoiceEvents(events) {
  const invoiceIds = [...new Set(
    events
      .filter(e => String(e.eventCategory).toUpperCase() === 'INVOICE')
      .map(e => e.resourceId)
      .filter(Boolean)
  )];
  if (invoiceIds.length === 0) return;

  const invoices = await getInvoicesByIds(invoiceIds);
  for (const inv of invoices.values()) {
    if (String(inv.status).toUpperCase() !== 'PAID') continue;
    // Extras billed on this invoice are now paid — drop them from outstanding.
    try {
      await markExtrasPaidForXeroInvoice(inv.invoiceId);
    } catch (err) {
      console.error('[xero webhook] mark extras paid failed', err);
    }
    // A paid proposal-billing invoice (deposit / full / PO) → move its deal into
    // production, same as the Stripe paid flow. Done regardless of contactId.
    await advanceDealForPaidInvoice(inv);
    if (!inv.contactId) continue;
    await creditForPaidInvoice(inv);
  }
}

// When a Xero invoice we raised for a proposal is paid, advance the linked deal
// to 'paid'. Best-effort + idempotent (advanceStage no-ops if already paid).
// Production no longer opens on payment — a person marks the deal "Good to go".
async function advanceDealForPaidInvoice(inv) {
  try {
    const [row] = await sql`SELECT proposal_id FROM proposal_billing WHERE xero_invoice_id = ${inv.invoiceId} LIMIT 1`;
    const proposalId = row?.proposal_id;
    if (!proposalId) return;
    const dealId = await dealIdForProposal(proposalId);
    if (!dealId) return;
    await advanceStage(dealId, 'paid', { payload: { proposalId, source: 'xero-webhook', invoice: inv.invoiceNumber || inv.invoiceId } });
  } catch (err) {
    console.error('[xero webhook] advance deal to paid failed', err);
  }
}

// Credits every active partner subscription linked to this invoice's contact,
// once per (invoice, subscription). Optional xero_invoice_reference scopes the
// match so unrelated invoices to the same contact don't trigger crediting.
async function creditForPaidInvoice(inv) {
  const subs = await sql`
    SELECT stripe_subscription_id, client_key, client_name,
           credits_per_month, xero_invoice_reference
      FROM partner_subscriptions
     WHERE xero_contact_id = ${inv.contactId}
       AND status = 'active'
  `;
  if (subs.length === 0) return;

  for (const sub of subs) {
    const ref = (sub.xero_invoice_reference || '').trim().toLowerCase();
    if (ref) {
      const invRef = (inv.reference || '').toLowerCase();
      if (!invRef.includes(ref)) continue;
    }
    const credits = Number(sub.credits_per_month) || 0;
    if (credits <= 0) continue;

    const sourceRef = `xero:${inv.invoiceId}:${sub.stripe_subscription_id}`;
    const label = inv.invoiceNumber || inv.invoiceId;
    const [row] = await sql`
      INSERT INTO credit_allocations
        (client_key, proposal_id, description, credit_cost, kind, allocated_by, notes, source_ref, allocated_at)
      VALUES
        (${sub.client_key}, NULL,
         ${'Subscription payment — ' + label}, ${credits}, 'adjustment', NULL,
         ${'Auto-credited from paid Xero invoice ' + label}, ${sourceRef},
         ${inv.fullyPaidOn ? inv.fullyPaidOn + 'T12:00:00Z' : null}::TIMESTAMPTZ)
      ON CONFLICT (source_ref) DO NOTHING
      RETURNING id
    `;
    // No row → we'd already credited this invoice for this sub. Stay quiet.
    if (!row) continue;

    try {
      const name = sub.client_name || sub.client_key;
      const link = `${APP_URL}/#/partner-credits`;
      await sendNotification('payment.partner_credit', {
        subject: `🔁 Subscription payment: ${name}`,
        html: `<p>Xero invoice <strong>${escapeHtml(label)}</strong> for <strong>${escapeHtml(name)}</strong> was paid.</p>
               <p><strong>${credits}</strong> credit${credits === 1 ? '' : 's'} added automatically.</p>
               <p><a href="${link}">Open Partner Credits</a></p>`,
        text: `${name}: Xero invoice ${label} paid — ${credits} credit(s) added automatically. ${link}`,
      });
    } catch (err) {
      console.error('[xero webhook] notification failed', err);
    }
  }
}
