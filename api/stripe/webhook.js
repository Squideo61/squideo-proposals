import Stripe from 'stripe';
import sql from '../_lib/db.js';

// Vercel must not parse the body — stripe.webhooks.constructEvent needs the raw bytes
// to verify the Stripe-Signature HMAC. Parsed JSON breaks signature verification.
export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: 'Webhook signature verification failed: ' + err.message });
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
