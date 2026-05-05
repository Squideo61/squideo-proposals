import Stripe from 'stripe';
import sql from '../_lib/db.js';
import { cors } from '../_lib/middleware.js';
import { sendMail, paidHtml, clientPaidThanksHtml, APP_URL } from '../_lib/email.js';

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
            INSERT INTO payments (proposal_id, amount, payment_type, paid_at, stripe_session_id, customer_email, receipt_url)
            VALUES (${proposalId}, ${amount}, ${isDeposit ? 'deposit' : 'full'},
                    NOW(), ${session.id}, ${session.customer_details?.email || null}, ${receiptUrl})
            ON CONFLICT (proposal_id) DO UPDATE
              SET amount = EXCLUDED.amount, payment_type = EXCLUDED.payment_type,
                  paid_at = EXCLUDED.paid_at, stripe_session_id = EXCLUDED.stripe_session_id,
                  customer_email = EXCLUDED.customer_email,
                  receipt_url = COALESCE(EXCLUDED.receipt_url, payments.receipt_url)
            RETURNING (xmax = 0) AS inserted
          `;
          const isFirstWrite = upserted[0]?.inserted === true;

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
    const { proposalId, amount, isDeposit, customerEmail, partner } = body;
    if (!proposalId || !amount) return res.status(400).json({ error: 'proposalId and amount required' });

    const validEmail = typeof customerEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail.trim())
      ? customerEmail.trim()
      : undefined;

    try {
      const successUrl = 'https://squideo-proposals-tu96.vercel.app/?proposal=' + proposalId
                       + '&session_id={CHECKOUT_SESSION_ID}';
      const cancelUrl = 'https://squideo-proposals-tu96.vercel.app/?proposal=' + proposalId + '&thanks=1';

      // Partner Programme: charge project + first-month partner combined as a
      // single one-off payment. Stripe Checkout doesn't support mixing one-off
      // and recurring items in a single session, so the recurring subscription
      // for months 2+ is set up separately (manually or via a future webhook
      // hook off `checkout.session.completed` — metadata below carries the
      // info needed to create the subscription programmatically later).
      if (partner && partner.partnerExVat > 0) {
        const vatRate = Number(partner.vatRate) || 0;
        const projectGross = partner.projectExVat * (1 + vatRate);
        const partnerMonthlyGross = partner.partnerExVat * (1 + vatRate);

        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          customer_email: validEmail,
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
