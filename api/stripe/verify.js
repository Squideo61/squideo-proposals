import Stripe from 'stripe';
import sql from '../_lib/db.js';
import { cors } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const { session_id, proposalId } = req.query;
  if (!session_id || !proposalId) {
    return res.status(400).json({ error: 'session_id and proposalId required' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const session = await stripe.checkout.sessions.retrieve(session_id);

  if (session.payment_status !== 'paid') {
    return res.status(402).json({ error: 'Payment not completed' });
  }
  if (session.metadata?.proposalId !== proposalId) {
    return res.status(403).json({ error: 'Session does not match proposal' });
  }

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
