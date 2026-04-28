import Stripe from 'stripe';
import { cors } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { proposalId, amount, isDeposit, customerEmail } = req.body;
  if (!proposalId || !amount) {
    return res.status(400).json({ error: 'proposalId and amount required' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
