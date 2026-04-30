import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;

  if (req.method === 'GET') {
    const rows = await sql`SELECT amount, payment_type, paid_at, stripe_session_id, customer_email FROM payments WHERE proposal_id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    return res.status(200).json({ amount: r.amount, paymentType: r.payment_type, paidAt: r.paid_at, stripeSessionId: r.stripe_session_id, customerEmail: r.customer_email });
  }

  if (req.method === 'POST') {
    const user = await requireAuth(req, res);
    if (!user) return;
    const { amount, paymentType, paidAt, stripeSessionId, customerEmail } = req.body;
    await sql`
      INSERT INTO payments (proposal_id, amount, payment_type, paid_at, stripe_session_id, customer_email)
      VALUES (${id}, ${amount}, ${paymentType}, ${paidAt}, ${stripeSessionId}, ${customerEmail})
      ON CONFLICT (proposal_id) DO UPDATE
        SET amount = EXCLUDED.amount, payment_type = EXCLUDED.payment_type,
            paid_at = EXCLUDED.paid_at, stripe_session_id = EXCLUDED.stripe_session_id,
            customer_email = EXCLUDED.customer_email
    `;
    return res.status(201).json({ ok: true });
  }

  res.status(405).end();
}
