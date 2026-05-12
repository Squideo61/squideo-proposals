import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';
import { verifyToken } from '../_lib/auth.js';
import { advanceStage, dealIdForProposal } from '../_lib/dealStage.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;

  if (req.method === 'GET') {
    // Public read — used by the client's thank-you flow. Sensitive fields
    // (customer_email, stripe_session_id) are only returned to authenticated
    // team members so a third party with a proposal ID can't enumerate them.
    const rows = await sql`SELECT amount, payment_type, paid_at, stripe_session_id, customer_email, receipt_url FROM payments WHERE proposal_id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    const header = req.headers.authorization || '';
    let isTeam = false;
    if (header.startsWith('Bearer ')) {
      try {
        await verifyToken(header.slice(7));
        isTeam = true;
      } catch { /* fall through to public projection */ }
    }
    const base = { amount: r.amount, paymentType: r.payment_type, paidAt: r.paid_at, receiptUrl: r.receipt_url };
    if (isTeam) {
      return res.status(200).json({ ...base, stripeSessionId: r.stripe_session_id, customerEmail: r.customer_email });
    }
    return res.status(200).json(base);
  }

  if (req.method === 'POST') {
    const user = await requireAuth(req, res);
    if (!user) return;
    // Manual payment record — admin only. Real payments come in via the
    // Stripe webhook; this is for back-office corrections.
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const { amount, paymentType, paidAt, stripeSessionId, customerEmail, receiptUrl } = req.body;
    await sql`
      INSERT INTO payments (proposal_id, amount, payment_type, paid_at, stripe_session_id, customer_email, receipt_url)
      VALUES (${id}, ${amount}, ${paymentType}, ${paidAt}, ${stripeSessionId}, ${customerEmail}, ${receiptUrl || null})
      ON CONFLICT (proposal_id) DO UPDATE
        SET amount = EXCLUDED.amount, payment_type = EXCLUDED.payment_type,
            paid_at = EXCLUDED.paid_at, stripe_session_id = EXCLUDED.stripe_session_id,
            customer_email = EXCLUDED.customer_email,
            receipt_url = COALESCE(EXCLUDED.receipt_url, payments.receipt_url)
    `;

    // CRM: advance the linked deal to 'paid'. Best-effort.
    try {
      const dealId = await dealIdForProposal(id);
      if (dealId) {
        await advanceStage(dealId, 'paid', { actorEmail: user.email || null, payload: { proposalId: id, amount, paymentType } });
      }
    } catch (err) {
      console.error('[payments] advanceStage failed', err);
    }

    return res.status(201).json({ ok: true });
  }

  res.status(405).end();
}
