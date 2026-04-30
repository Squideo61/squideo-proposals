import Stripe from 'stripe';
import sql from '../_lib/db.js';
import { cors } from '../_lib/middleware.js';
import { sendMail, paidHtml, APP_URL } from '../_lib/email.js';

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
          await sql`
            INSERT INTO payments (proposal_id, amount, payment_type, paid_at, stripe_session_id, customer_email)
            VALUES (${proposalId}, ${amount}, ${isDeposit ? 'deposit' : 'full'},
                    NOW(), ${session.id}, ${session.customer_details?.email || null})
            ON CONFLICT (proposal_id) DO UPDATE
              SET amount = EXCLUDED.amount, payment_type = EXCLUDED.payment_type,
                  paid_at = EXCLUDED.paid_at, stripe_session_id = EXCLUDED.stripe_session_id,
                  customer_email = EXCLUDED.customer_email
          `;

          // Notify the proposal creator. Best-effort — failures here mustn't
          // affect the webhook's 200 response (Stripe will retry otherwise and
          // we'd record duplicate payments via the idempotent upsert above).
          try {
            const [proposalRows, sigRows] = await Promise.all([
              sql`SELECT data FROM proposals WHERE id = ${proposalId}`,
              sql`SELECT name, email FROM signatures WHERE proposal_id = ${proposalId}`,
            ]);
            const proposal = proposalRows[0]?.data || {};
            const ownerEmail = proposal.preparedByEmail || null;
            if (ownerEmail) {
              // Pull the Stripe-hosted receipt URL from the latest charge so
              // the email's button takes the user straight to it.
              let receiptUrl = null;
              try {
                if (session.payment_intent) {
                  const pi = await stripe.paymentIntents.retrieve(session.payment_intent, { expand: ['latest_charge'] });
                  receiptUrl = pi.latest_charge?.receipt_url || null;
                }
              } catch (err) {
                console.warn('[stripe webhook] could not fetch receipt URL', err.message);
              }

              const sig = sigRows[0] || {};
              const title = proposal.proposalTitle || proposal.clientName || proposalId;
              const link = `${APP_URL}/?proposal=${proposalId}`;
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
      const cancelUrl = 'https://squideo-proposals-tu96.vercel.app/?proposal=' + proposalId;

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
                product_data: { name: 'Video production — discounted project' },
                unit_amount: Math.round(projectGross * 100),
              },
              quantity: 1,
            },
            {
              price_data: {
                currency: 'gbp',
                product_data: {
                  name: 'Squideo Partner Programme — first month'
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
              name: isDeposit ? 'Video production — 50% deposit' : 'Video production — full payment',
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
    const payment = {
      amount: session.amount_total / 100,
      paymentType: isDeposit ? 'deposit' : 'full',
      paidAt: new Date().toISOString(),
      stripeSessionId: session_id,
      customerEmail: session.customer_details?.email || null,
    };

    await sql`
      INSERT INTO payments (proposal_id, amount, payment_type, paid_at, stripe_session_id, customer_email)
      VALUES (${proposalId}, ${payment.amount}, ${payment.paymentType}, ${payment.paidAt},
              ${payment.stripeSessionId}, ${payment.customerEmail})
      ON CONFLICT (proposal_id) DO UPDATE
        SET amount = EXCLUDED.amount, payment_type = EXCLUDED.payment_type,
            paid_at = EXCLUDED.paid_at, stripe_session_id = EXCLUDED.stripe_session_id,
            customer_email = EXCLUDED.customer_email
    `;

    return res.status(200).json(payment);
  }

  res.status(404).end();
}
