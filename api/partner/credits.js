// GET /api/partner/credits — admin: list of clients with credit totals.
import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  // Per-subscription tally: credits_per_month × months_paid.
  // months_paid = 1 (first month bundled into the Stripe checkout) + the
  // number of recurring partner_invoices captured since.
  const rows = await sql`
    WITH sub_totals AS (
      SELECT
        ps.client_key,
        ps.client_name,
        ps.credits_per_month,
        ps.status,
        ps.proposal_id,
        1 + COALESCE(
          (SELECT COUNT(*) FROM partner_invoices pi WHERE pi.proposal_id = ps.proposal_id),
          0
        ) AS months_paid,
        (SELECT MAX(paid_at) FROM partner_invoices pi WHERE pi.proposal_id = ps.proposal_id) AS last_recurring,
        (SELECT paid_at FROM payments p WHERE p.proposal_id = ps.proposal_id) AS initial_paid
      FROM partner_subscriptions ps
    ),
    summary AS (
      SELECT
        client_key,
        MAX(client_name) AS client_name,
        COUNT(*)::INT AS sub_count,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)::INT AS sub_active_count,
        COALESCE(SUM(credits_per_month * months_paid), 0)::NUMERIC AS credits_issued,
        GREATEST(MAX(last_recurring), MAX(initial_paid)) AS last_payment_at,
        BOOL_OR(status = 'active') AS any_active
      FROM sub_totals
      GROUP BY client_key
    ),
    used AS (
      SELECT client_key, COALESCE(SUM(credit_cost), 0)::NUMERIC AS credits_used
      FROM credit_allocations
      GROUP BY client_key
    )
    SELECT
      s.client_key,
      s.client_name,
      s.sub_count,
      s.sub_active_count,
      s.credits_issued,
      COALESCE(u.credits_used, 0) AS credits_used,
      (s.credits_issued - COALESCE(u.credits_used, 0)) AS credits_remaining,
      s.last_payment_at,
      CASE WHEN s.any_active THEN 'active' ELSE 'inactive' END AS status
    FROM summary s
    LEFT JOIN used u ON u.client_key = s.client_key
    ORDER BY s.any_active DESC, s.client_name NULLS LAST
  `;

  const list = rows.map(r => ({
    clientKey: r.client_key,
    clientName: r.client_name,
    subscriptions: { count: r.sub_count, active: r.sub_active_count },
    creditsIssued: Number(r.credits_issued) || 0,
    creditsUsed: Number(r.credits_used) || 0,
    creditsRemaining: Number(r.credits_remaining) || 0,
    lastPaymentAt: r.last_payment_at,
    status: r.status,
  }));

  return res.status(200).json(list);
}
