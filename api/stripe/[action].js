import Stripe from 'stripe';
import sql from '../_lib/db.js';
import { cors } from '../_lib/middleware.js';
import { sendMail, paidHtml, clientPaidThanksHtml, APP_URL } from '../_lib/email.js';
import { getOrCreateContact, createInvoice, emailInvoice } from '../_lib/xero.js';
import {
  lineItemsForProject,
  lineItemsForDiscountedProject,
  lineItemsForPartnerFirstMonth,
  lineItemsForPartnerMonthly,
  depositLineItems,
} from '../_lib/xeroMappers.js';

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

// Best-effort Xero invoice creation for a checkout.session.completed event.
// Persists xero_invoice_id on the payments row so retries are idempotent.
// All errors are swallowed and logged so the webhook can still 200 to Stripe.
async function pushInitialXeroInvoice({ proposalId, isDeposit, isPartner }) {
  try {
    const [paymentRow] = await sql`SELECT xero_invoice_id FROM payments WHERE proposal_id = ${proposalId}`;
    if (paymentRow?.xero_invoice_id) return; // already pushed
    const [billingRow] = await sql`SELECT billing FROM proposal_billing WHERE proposal_id = ${proposalId}`;
    const billing = billingRow?.billing;
    if (!billing) {
      console.warn('[xero] no billing for proposal, skipping invoice', { proposalId });
      return;
    }

    const [proposalRows, sigRows] = await Promise.all([
      sql`SELECT data FROM proposals WHERE id = ${proposalId}`,
      sql`SELECT name, email, data FROM signatures WHERE proposal_id = ${proposalId}`,
    ]);
    const proposal = proposalRows[0]?.data || {};
    const sigRow = sigRows[0];
    if (!sigRow) {
      console.warn('[xero] no signature for proposal, skipping invoice', { proposalId });
      return;
    }
    const signed = { name: sigRow.name, email: sigRow.email, ...(sigRow.data || {}) };

    const contact = billingToContact(billing, signed.email);
    if (!contact?.name) {
      console.warn('[xero] billing missing company name, skipping', { proposalId });
      return;
    }
    const contactId = await getOrCreateContact(contact);

    let lineItems;
    if (isPartner) {
      lineItems = [
        ...lineItemsForDiscountedProject(proposal, signed),
        ...lineItemsForPartnerFirstMonth(proposal, signed),
      ];
    } else if (isDeposit) {
      lineItems = depositLineItems(proposal, signed, 0.5);
    } else {
      lineItems = lineItemsForProject(proposal, signed);
    }

    const dueDate = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
    const reference = (proposal.proposalTitle || proposal.clientName || proposalId).slice(0, 60);
    const invoiceId = await createInvoice({
      contactId,
      lineItems,
      reference,
      dueDate,
      status: 'AUTHORISED',
    });

    await sql`UPDATE payments SET xero_invoice_id = ${invoiceId} WHERE proposal_id = ${proposalId}`;

    try { await emailInvoice(invoiceId); }
    catch (err) { console.error('[xero] emailInvoice failed (invoice still authorised)', err); }
  } catch (err) {
    console.error('[xero] pushInitialXeroInvoice failed', err);
  }
}

// Best-effort partner-programme subscription setup. Only fires after a
// successful first-month checkout where we saved the card via
// setup_future_usage. Months 2+ are then collected automatically by Stripe
// and surface here as invoice.payment_succeeded events.
async function setupPartnerSubscription({ stripe, session, proposalId }) {
  try {
    const [row] = await sql`SELECT partner_subscription_id FROM payments WHERE proposal_id = ${proposalId}`;
    if (row?.partner_subscription_id) return;
    if (!session.customer) return;

    const partnerMonthlyGross = Number(session.metadata?.partnerMonthlyGross);
    if (!partnerMonthlyGross || partnerMonthlyGross <= 0) {
      console.warn('[stripe] partner monthly gross missing on session metadata', { proposalId });
      return;
    }

    const pi = session.payment_intent
      ? await stripe.paymentIntents.retrieve(session.payment_intent)
      : null;
    const paymentMethodId = pi?.payment_method;
    if (!paymentMethodId) {
      console.warn('[stripe] no payment method to attach for subscription', { proposalId });
      return;
    }

    await stripe.paymentMethods.attach(paymentMethodId, { customer: session.customer })
      .catch(err => {
        if (err?.code !== 'resource_already_exists') throw err;
      });
    await stripe.customers.update(session.customer, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    const anchor = Math.floor((Date.now() + 30 * 86400_000) / 1000);
    const subscription = await stripe.subscriptions.create({
      customer: session.customer,
      items: [{
        price_data: {
          currency: 'gbp',
          product_data: { name: 'Squideo Partner Programme — monthly' },
          recurring: { interval: 'month' },
          unit_amount: partnerMonthlyGross,
        },
      }],
      default_payment_method: paymentMethodId,
      billing_cycle_anchor: anchor,
      proration_behavior: 'none',
      off_session: true,
      metadata: {
        proposalId,
        kind: 'partner-programme',
      },
    });

    await sql`
      UPDATE payments
        SET partner_subscription_id = ${subscription.id},
            stripe_customer_id = COALESCE(stripe_customer_id, ${session.customer})
        WHERE proposal_id = ${proposalId}
    `;
  } catch (err) {
    console.error('[stripe] setupPartnerSubscription failed', err);
  }
}

async function pushRecurringXeroInvoice({ stripe, invoice }) {
  try {
    if (!invoice.subscription) return;
    const sub = typeof invoice.subscription === 'string'
      ? await stripe.subscriptions.retrieve(invoice.subscription)
      : invoice.subscription;
    if (sub.metadata?.kind !== 'partner-programme') return;
    const proposalId = sub.metadata?.proposalId;
    if (!proposalId) return;

    const [existing] = await sql`SELECT xero_invoice_id FROM partner_invoices WHERE stripe_invoice_id = ${invoice.id}`;
    if (existing?.xero_invoice_id) return;

    const [billingRow, proposalRows, sigRows, countRows] = await Promise.all([
      sql`SELECT billing FROM proposal_billing WHERE proposal_id = ${proposalId}`,
      sql`SELECT data FROM proposals WHERE id = ${proposalId}`,
      sql`SELECT name, email, data FROM signatures WHERE proposal_id = ${proposalId}`,
      sql`SELECT COUNT(*)::int AS n FROM partner_invoices WHERE proposal_id = ${proposalId}`,
    ]);
    const billing = billingRow?.billing;
    const proposal = proposalRows[0]?.data || {};
    const sigRow = sigRows[0];
    if (!billing || !sigRow) {
      console.warn('[xero] missing billing or signature for recurring invoice', { proposalId });
      return;
    }
    const signed = { name: sigRow.name, email: sigRow.email, ...(sigRow.data || {}) };
    const contact = billingToContact(billing, signed.email);
    const contactId = await getOrCreateContact(contact);

    // Months are 2-indexed (month 1 was the first-month line on the initial invoice).
    const monthNumber = (countRows[0]?.n || 0) + 2;
    const lineItems = lineItemsForPartnerMonthly(proposal, signed, monthNumber);

    const amount = invoice.amount_paid ? invoice.amount_paid / 100 : null;
    await sql`
      INSERT INTO partner_invoices (stripe_invoice_id, proposal_id, amount, paid_at)
      VALUES (${invoice.id}, ${proposalId}, ${amount}, NOW())
      ON CONFLICT (stripe_invoice_id) DO NOTHING
    `;

    const dueDate = new Date().toISOString().slice(0, 10);
    const xeroInvoiceId = await createInvoice({
      contactId,
      lineItems,
      reference: `Partner month ${monthNumber} — ${proposal.proposalTitle || proposal.clientName || proposalId}`.slice(0, 80),
      dueDate,
      status: 'AUTHORISED',
    });
    await sql`UPDATE partner_invoices SET xero_invoice_id = ${xeroInvoiceId} WHERE stripe_invoice_id = ${invoice.id}`;

    try { await emailInvoice(xeroInvoiceId); }
    catch (err) { console.error('[xero] recurring emailInvoice failed', err); }
  } catch (err) {
    console.error('[xero] pushRecurringXeroInvoice failed', err);
  }
}

// bodyParser must be off so the webhook path gets raw bytes for signature verification.
// For checkout/verify we parse the raw body manually below.
export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  // Collect raw body (needed for webhook; parsed manually for other routes)
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);

  // --- WEBHOOK ---
  if (action === 'webhook') {
    if (req.method !== 'POST') return res.status(405).end();
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).json({ error: 'Webhook signature failed: ' + err.message });
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.payment_status === 'paid') {
        const proposalId = session.metadata?.proposalId;
        if (proposalId) {
          const isDeposit = session.metadata?.isDeposit === 'true';
          const amount = session.amount_total / 100;

          // Pull the Stripe-hosted receipt URL from the latest charge so we
          // can persist it and link to it from the client thank-you email.
          let receiptUrl = null;
          try {
            if (session.payment_intent) {
              const pi = await stripe.paymentIntents.retrieve(session.payment_intent, { expand: ['latest_charge'] });
              receiptUrl = pi.latest_charge?.receipt_url || null;
            }
          } catch (err) {
            console.warn('[stripe webhook] could not fetch receipt URL', err.message);
          }

          // xmax = 0 in RETURNING is true only when the row was actually
          // inserted, false on UPDATE. We use that to send the client
          // thank-you email exactly once even if verify and webhook race.
          const upserted = await sql`
            INSERT INTO payments (proposal_id, amount, payment_type, paid_at, stripe_session_id, customer_email, receipt_url, stripe_customer_id)
            VALUES (${proposalId}, ${amount}, ${isDeposit ? 'deposit' : 'full'},
                    NOW(), ${session.id}, ${session.customer_details?.email || null}, ${receiptUrl},
                    ${session.customer || null})
            ON CONFLICT (proposal_id) DO UPDATE
              SET amount = EXCLUDED.amount, payment_type = EXCLUDED.payment_type,
                  paid_at = EXCLUDED.paid_at, stripe_session_id = EXCLUDED.stripe_session_id,
                  customer_email = EXCLUDED.customer_email,
                  receipt_url = COALESCE(EXCLUDED.receipt_url, payments.receipt_url),
                  stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, payments.stripe_customer_id)
            RETURNING (xmax = 0) AS inserted
          `;
          const isFirstWrite = upserted[0]?.inserted === true;
          const isPartner = session.metadata?.partnerProgramme === 'true';

          // Push the Xero invoice (idempotent on xero_invoice_id) and, for
          // Partner Programme card payers, set up the Stripe Subscription
          // that drives months 2+. Both are best-effort — we always 200 to
          // Stripe so the event isn't retried.
          await pushInitialXeroInvoice({ proposalId, isDeposit, isPartner });
          if (isPartner) {
            await setupPartnerSubscription({ stripe, session, proposalId });
          }

          // Best-effort emails — failures here mustn't affect the webhook's
          // 200 response (Stripe would retry and we'd risk duplicates).
          try {
            const [proposalRows, sigRows] = await Promise.all([
              sql`SELECT data FROM proposals WHERE id = ${proposalId}`,
              sql`SELECT name, email FROM signatures WHERE proposal_id = ${proposalId}`,
            ]);
            const proposal = proposalRows[0]?.data || {};
            const ownerEmail = proposal.preparedByEmail || null;
            const sig = sigRows[0] || {};
            const title = proposal.proposalTitle || proposal.clientName || proposalId;
            const link = `${APP_URL}/?proposal=${proposalId}`;

            if (isFirstWrite && ownerEmail) {
              await sendMail({
                to: ownerEmail,
                subject: `💰 Payment received: ${title}`,
                html: paidHtml({
                  proposal,
                  signerName: sig.name || session.customer_details?.name,
                  signerEmail: sig.email || session.customer_details?.email,
                  amount,
                  paymentType: isDeposit ? 'deposit' : 'full',
                  paidAt: new Date().toISOString(),
                  receiptUrl,
                  link,
                }),
                text: `${sig.name || 'A client'} paid £${amount.toFixed(2)} (${isDeposit ? '50% deposit' : 'full payment'}) for "${title}".${receiptUrl ? ' Receipt: ' + receiptUrl : ''} ${link}`,
              });
            }

            const clientEmail = sig.email || session.customer_details?.email;
            if (isFirstWrite && clientEmail) {
              const signedProposalLink = `${APP_URL}/?proposal=${proposalId}&thanks=1&download=signed`;
              await sendMail({
                to: clientEmail,
                subject: `Payment received - ${title}`,
                html: clientPaidThanksHtml({ proposal, clientName: sig.name, signedProposalLink, receiptUrl }),
                text: `Thanks${sig.name ? ', ' + sig.name : ''}! Payment received for "${title}". Signed proposal: ${signedProposalLink}${receiptUrl ? ' · Receipt: ' + receiptUrl : ''}`,
              });
            }
          } catch (err) {
            console.error('[stripe webhook] payment-received email failed', err);
          }
        }
      }
    }

    if (event.type === 'invoice.payment_succeeded') {
      // Recurring Partner Programme charges land here once Stripe collects
      // each monthly subscription invoice. We mirror it into Xero as an
      // AUTHORISED invoice and email it to the billing contact.
      await pushRecurringXeroInvoice({ stripe, invoice: event.data.object });
    }

    return res.status(200).json({ received: true });
  }

  // Parse body as JSON for non-webhook routes
  let body = {};
  if (rawBody.length > 0) {
    try { body = JSON.parse(rawBody.toString()); } catch {}
  }

  // --- CHECKOUT ---
  if (action === 'checkout') {
    if (req.method !== 'POST') return res.status(405).end();
    const { proposalId, amount, isDeposit, customerEmail, partner, billing } = body;
    if (!proposalId || !amount) return res.status(400).json({ error: 'proposalId and amount required' });

    const validEmail = typeof customerEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail.trim())
      ? customerEmail.trim()
      : undefined;

    // Persist billing JSON keyed by proposalId so the webhook can build a Xero
    // contact + invoice without needing every billing field round-tripped via
    // Stripe metadata.
    if (billing) {
      await sql`
        INSERT INTO proposal_billing (proposal_id, billing)
        VALUES (${proposalId}, ${JSON.stringify(billing)})
        ON CONFLICT (proposal_id) DO UPDATE
          SET billing = EXCLUDED.billing, updated_at = NOW()
      `;
    }

    try {
      const successUrl = 'https://squideo-proposals-tu96.vercel.app/?proposal=' + proposalId
                       + '&session_id={CHECKOUT_SESSION_ID}';
      const cancelUrl = 'https://squideo-proposals-tu96.vercel.app/?proposal=' + proposalId + '&thanks=1';

      // Partner Programme: charge project + first-month partner combined as a
      // single one-off payment. Stripe Checkout doesn't support mixing one-off
      // and recurring items in a single session, so the recurring subscription
      // for months 2+ is set up by the webhook after this session completes —
      // setup_future_usage saves the card so we can charge it off-session.
      if (partner && partner.partnerExVat > 0) {
        const vatRate = Number(partner.vatRate) || 0;
        const projectGross = partner.projectExVat * (1 + vatRate);
        const partnerMonthlyGross = partner.partnerExVat * (1 + vatRate);

        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          customer_email: validEmail,
          customer_creation: 'always',
          payment_intent_data: { setup_future_usage: 'off_session' },
          line_items: [
            {
              price_data: {
                currency: 'gbp',
                product_data: { name: 'Video production - discounted project' },
                unit_amount: Math.round(projectGross * 100),
              },
              quantity: 1,
            },
            {
              price_data: {
                currency: 'gbp',
                product_data: {
                  name: 'Squideo Partner Programme - first month'
                    + (partner.partnerCredits ? ` (${partner.partnerCredits} min credit)` : ''),
                },
                unit_amount: Math.round(partnerMonthlyGross * 100),
              },
              quantity: 1,
            },
          ],
          metadata: {
            proposalId,
            isDeposit: 'false',
            partnerProgramme: 'true',
            partnerCredits: String(partner.partnerCredits || 1),
            projectGross: String(Math.round(projectGross * 100)),
            partnerMonthlyGross: String(Math.round(partnerMonthlyGross * 100)),
          },
          success_url: successUrl,
          cancel_url: cancelUrl,
        });

        return res.status(200).json({ url: session.url });
      }

      // Standard one-off payment (no partner).
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: validEmail,
        customer_creation: 'always',
        line_items: [{
          price_data: {
            currency: 'gbp',
            product_data: {
              name: isDeposit ? 'Video production - 50% deposit' : 'Video production - full payment',
            },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        }],
        metadata: { proposalId, isDeposit: isDeposit ? 'true' : 'false' },
        success_url: successUrl,
        cancel_url: cancelUrl,
      });

      return res.status(200).json({ url: session.url });
    } catch (err) {
      console.error('[stripe checkout] failed', err);
      return res.status(502).json({ error: err.message || 'Stripe checkout failed' });
    }
  }

  // --- VERIFY ---
  if (action === 'verify') {
    if (req.method !== 'GET') return res.status(405).end();
    const { session_id, proposalId } = req.query;
    if (!session_id || !proposalId) return res.status(400).json({ error: 'session_id and proposalId required' });

    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') return res.status(402).json({ error: 'Payment not completed' });
    if (session.metadata?.proposalId !== proposalId) return res.status(403).json({ error: 'Session mismatch' });

    const isDeposit = session.metadata?.isDeposit === 'true';

    let receiptUrl = null;
    try {
      if (session.payment_intent) {
        const pi = await stripe.paymentIntents.retrieve(session.payment_intent, { expand: ['latest_charge'] });
        receiptUrl = pi.latest_charge?.receipt_url || null;
      }
    } catch (err) {
      console.warn('[stripe verify] could not fetch receipt URL', err.message);
    }

    const payment = {
      amount: session.amount_total / 100,
      paymentType: isDeposit ? 'deposit' : 'full',
      paidAt: new Date().toISOString(),
      stripeSessionId: session_id,
      customerEmail: session.customer_details?.email || null,
      receiptUrl,
    };

    const upserted = await sql`
      INSERT INTO payments (proposal_id, amount, payment_type, paid_at, stripe_session_id, customer_email, receipt_url)
      VALUES (${proposalId}, ${payment.amount}, ${payment.paymentType}, ${payment.paidAt},
              ${payment.stripeSessionId}, ${payment.customerEmail}, ${receiptUrl})
      ON CONFLICT (proposal_id) DO UPDATE
        SET amount = EXCLUDED.amount, payment_type = EXCLUDED.payment_type,
            paid_at = EXCLUDED.paid_at, stripe_session_id = EXCLUDED.stripe_session_id,
            customer_email = EXCLUDED.customer_email,
            receipt_url = COALESCE(EXCLUDED.receipt_url, payments.receipt_url)
      RETURNING (xmax = 0) AS inserted
    `;
    const isFirstWrite = upserted[0]?.inserted === true;

    if (isFirstWrite) {
      try {
        const [proposalRows, sigRows] = await Promise.all([
          sql`SELECT data FROM proposals WHERE id = ${proposalId}`,
          sql`SELECT name, email FROM signatures WHERE proposal_id = ${proposalId}`,
        ]);
        const proposal = proposalRows[0]?.data || {};
        const sig = sigRows[0] || {};
        const ownerEmail = proposal.preparedByEmail || null;
        const title = proposal.proposalTitle || proposal.clientName || proposalId;
        const link = `${APP_URL}/?proposal=${proposalId}`;

        if (ownerEmail) {
          await sendMail({
            to: ownerEmail,
            subject: `💰 Payment received: ${title}`,
            html: paidHtml({
              proposal,
              signerName: sig.name || session.customer_details?.name,
              signerEmail: sig.email || session.customer_details?.email,
              amount: payment.amount,
              paymentType: payment.paymentType,
              paidAt: payment.paidAt,
              receiptUrl,
              link,
            }),
            text: `${sig.name || 'A client'} paid £${payment.amount.toFixed(2)} (${isDeposit ? '50% deposit' : 'full payment'}) for "${title}".${receiptUrl ? ' Receipt: ' + receiptUrl : ''} ${link}`,
          });
        }

        const clientEmail = sig.email || session.customer_details?.email;
        if (clientEmail) {
          const signedProposalLink = `${APP_URL}/?proposal=${proposalId}&thanks=1&download=signed`;
          await sendMail({
            to: clientEmail,
            subject: `Payment received - ${title}`,
            html: clientPaidThanksHtml({ proposal, clientName: sig.name, signedProposalLink, receiptUrl }),
            text: `Thanks${sig.name ? ', ' + sig.name : ''}! Payment received for "${title}". Signed proposal: ${signedProposalLink}${receiptUrl ? ' · Receipt: ' + receiptUrl : ''}`,
          });
        }
      } catch (err) {
        console.error('[stripe verify] payment-received email failed', err);
      }
    }

    return res.status(200).json(payment);
  }

  res.status(404).end();
}
