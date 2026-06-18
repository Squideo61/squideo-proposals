import sql from './db.js';

// Core partner-credit math, shared by the Partners & Credits list
// (api/partner/[action].js → listCredits) and the company "Current Projects"
// view (api/_lib/crm/companies.js). Returns issued / used / remaining + a
// three-way status per partner client.
//
// Credit model (mirrors the comments in api/partner/[action].js):
//  · Stripe-tracked subs: credits_per_month × (1 initial + recurring invoices).
//  · Manual subs, auto_credit=true: credits_per_month × (months elapsed + 1).
//  · Manual subs, auto_credit=false: 0 (topped up via adjustments).
//  · Adjustments (credit_allocations.kind='adjustment'): positive → issued,
//    negative → used. Work (kind='work') → used.
//
// `keys` scopes to a set of client_keys; pass null/empty for every client.
export async function creditTotalsForKeys(keys) {
  const k = keys && keys.length ? keys : null;
  return await sql`
    WITH sub_totals AS (
      SELECT
        ps.client_key,
        ps.client_name,
        ps.status,
        ps.proposal_id,
        ps.stripe_subscription_id,
        (
          CASE
            WHEN ps.stripe_subscription_id LIKE 'manual_%' THEN
              CASE
                WHEN ps.auto_credit IS TRUE THEN
                  ps.credits_per_month * GREATEST(0,
                    EXTRACT(YEAR  FROM AGE(COALESCE(ps.canceled_at, NOW()), COALESCE(ps.start_date, ps.created_at::date)))::INT * 12 +
                    EXTRACT(MONTH FROM AGE(COALESCE(ps.canceled_at, NOW()), COALESCE(ps.start_date, ps.created_at::date)))::INT + 1
                  )
                ELSE 0
              END
            ELSE
              ps.credits_per_month * (
                1 + COALESCE(
                  (SELECT COUNT(*) FROM partner_invoices pi WHERE pi.proposal_id = ps.proposal_id),
                  0
                )
              )
          END
        )::NUMERIC AS issued_from_sub,
        (ps.status = 'active' AND (
          ps.stripe_subscription_id NOT LIKE 'manual_%'
          OR (ps.auto_credit IS TRUE AND ps.credits_per_month > 0)
        )) AS is_recurring_active,
        (ps.stripe_subscription_id LIKE 'manual_%'
          AND ps.auto_credit IS NOT TRUE
          AND ps.credits_per_month = 0) AS is_credits_only,
        (SELECT MAX(paid_at) FROM partner_invoices pi WHERE pi.proposal_id = ps.proposal_id) AS last_recurring,
        (SELECT paid_at FROM payments p WHERE p.proposal_id = ps.proposal_id) AS initial_paid
      FROM partner_subscriptions ps
      WHERE (${k}::text[] IS NULL OR ps.client_key = ANY(${k}::text[]))
    ),
    summary AS (
      SELECT
        client_key,
        MAX(client_name) AS client_name,
        COUNT(*)::INT AS sub_count,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)::INT AS sub_active_count,
        COALESCE(SUM(issued_from_sub), 0)::NUMERIC AS sub_issued,
        GREATEST(MAX(last_recurring), MAX(initial_paid)) AS last_payment_at,
        BOOL_OR(status = 'active') AS any_active,
        BOOL_OR(is_recurring_active) AS any_recurring_active,
        BOOL_OR(is_credits_only) AS any_credits_only
      FROM sub_totals
      GROUP BY client_key
    ),
    movements AS (
      SELECT
        client_key,
        COALESCE(SUM(CASE WHEN kind = 'adjustment' AND credit_cost > 0 THEN credit_cost ELSE 0 END), 0)::NUMERIC AS adj_added,
        COALESCE(SUM(CASE WHEN kind = 'adjustment' AND credit_cost < 0 THEN -credit_cost ELSE 0 END), 0)::NUMERIC AS adj_removed,
        COALESCE(SUM(CASE WHEN kind = 'work' THEN credit_cost ELSE 0 END), 0)::NUMERIC AS work_used
      FROM credit_allocations
      WHERE (${k}::text[] IS NULL OR client_key = ANY(${k}::text[]))
      GROUP BY client_key
    )
    SELECT
      s.client_key,
      s.client_name,
      s.sub_count,
      s.sub_active_count,
      (s.sub_issued + COALESCE(m.adj_added, 0))                                  AS credits_issued,
      (COALESCE(m.work_used, 0) + COALESCE(m.adj_removed, 0))                    AS credits_used,
      (s.sub_issued + COALESCE(m.adj_added, 0)
        - COALESCE(m.work_used, 0) - COALESCE(m.adj_removed, 0))                 AS credits_remaining,
      s.last_payment_at,
      CASE
        WHEN s.any_recurring_active THEN 'active'
        WHEN s.any_credits_only
          OR (s.sub_issued + COALESCE(m.adj_added, 0)
              - COALESCE(m.work_used, 0) - COALESCE(m.adj_removed, 0)) > 0
          THEN 'credits_only'
        ELSE 'inactive'
      END AS status
    FROM summary s
    LEFT JOIN movements m ON m.client_key = s.client_key
    ORDER BY s.any_recurring_active DESC, s.client_name NULLS LAST
  `;
}
