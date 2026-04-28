import Stripe from 'stripe';
import sql from '../_lib/db.js';
import { cors } from '../_lib/middleware.js';

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
          await sql`
            INSERT INTO payments (proposal_id, amount, payment_type, paid_at, stripe_session_id, customer_email)
            VALUES (${proposalId}, ${session.amount_total / 100}, ${isDeposit ? 'deposit' : 'full'},
                    NOW(), ${session.id}, ${session.customer_details?.email || null})
            ON CONFLICT (proposal_id) DO UPDATE
              SET amount = EXCLUDED.amount, payment_type = EXCLUDED.payment_type,
                  paid_at = EXCLUDED.paid_at, stripe_session_id = EXCLUDED.stripe_session_id,
                  customer_email = EXCLUDED.customer_email
          `;
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
    const { proposalId, amount, isDeposit, customerEmail } = body;
    if (!proposalId || !amount) return res.status(400).json({ error: 'proposalId and amount required' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: customerEmail || undefined,
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: isDeposit ? 'Video Production — 50% Deposit' : 'Video Production — Full Payment',
          },
          unit_amount: Math.round(amount * 100),
        },
        quantity: 1,
      }],
      metadata: { proposalId, isDeposit: isDeposit ? 'true' : 'false' },
      success_url: 'https://squideo-proposals-tu96.vercel.app/?proposal=' + proposalId
                   + '&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://squideo-proposals-tu96.vercel.app/?proposal=' + proposalId,
    });

    return res.status(200).json({ url: session.url });
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
