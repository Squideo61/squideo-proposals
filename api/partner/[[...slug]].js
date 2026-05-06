// Catch-all router for partner-programme admin endpoints.
//
//   GET    /api/partner/credits                  — list of clients with totals
//   GET    /api/partner/clients/:key             — per-client detail
//   POST   /api/partner/allocations              — log a work allocation
//   DELETE /api/partner/allocations/:id          — remove a logged allocation
//
// All routes require auth.
import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  const raw = req.query.slug;
  const slug = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
  const [resource, idOrKey] = slug;

  try {
    if (resource === 'credits' && !idOrKey) {
      if (req.method !== 'GET') return res.status(405).end();
      return await listCredits(res);
    }

    if (resource === 'clients' && idOrKey) {
      if (req.method !== 'GET') return res.status(405).end();
      return await clientDetail(res, idOrKey);
    }

    if (resource === 'allocations') {
      if (!idOrKey && req.method === 'POST')   return await logAllocation(req, res, user);
      if (idOrKey && req.method === 'DELETE')  return await deleteAllocation(res, idOrKey);
      return res.status(405).end();
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('[partner]', err);
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
}

async function listCredits(res) {
  // months_paid per subscription = 1 (first month bundled into the Stripe
  // checkout) + the number of recurring partner_invoices captured since.
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

async function clientDetail(res, key) {
  if (!key) return res.status(400).json({ error: 'client key required' });

  const [subscriptions, recurring, initial, allocations] = await Promise.all([
    sql`
      SELECT
        ps.stripe_subscription_id,
        ps.proposal_id,
        ps.client_name,
        ps.credits_per_month,
        ps.status,
        ps.current_period_end,
        ps.canceled_at,
        ps.created_at,
        p.number_year,
        p.number_seq,
        (p.data->>'proposalTitle') AS proposal_title,
        (p.data->>'clientName')    AS proposal_client_name
      FROM partner_subscriptions ps
      LEFT JOIN proposals p ON p.id = ps.proposal_id
      WHERE ps.client_key = ${key}
      ORDER BY ps.created_at ASC
    `,
    sql`
      SELECT pi.stripe_invoice_id, pi.proposal_id, pi.amount, pi.paid_at,
             ps.credits_per_month
      FROM partner_invoices pi
      JOIN partner_subscriptions ps ON ps.proposal_id = pi.proposal_id
      WHERE ps.client_key = ${key}
      ORDER BY pi.paid_at ASC
    `,
    sql`
      SELECT p.proposal_id, p.amount, p.paid_at, ps.credits_per_month
      FROM payments p
      JOIN partner_subscriptions ps ON ps.proposal_id = p.proposal_id
      WHERE ps.client_key = ${key}
        AND p.partner_subscription_id IS NOT NULL
      ORDER BY p.paid_at ASC
    `,
    sql`
      SELECT id, proposal_id, description, credit_cost,
             allocated_at, allocated_by, notes
      FROM credit_allocations
      WHERE client_key = ${key}
      ORDER BY allocated_at DESC, id DESC
    `,
  ]);

  if (subscriptions.length === 0) {
    return res.status(404).json({ error: 'Client not found' });
  }

  const formatProposalNumber = (year, seq) => {
    if (!year || !seq) return null;
    return String(year) + '-' + String(seq).padStart(4, '0');
  };

  const subs = subscriptions.map(s => ({
    stripeSubscriptionId: s.stripe_subscription_id,
    proposalId: s.proposal_id,
    proposalNumber: formatProposalNumber(s.number_year, s.number_seq),
    proposalTitle: s.proposal_title || s.proposal_client_name,
    creditsPerMonth: Number(s.credits_per_month) || 0,
    status: s.status,
    currentPeriodEnd: s.current_period_end,
    canceledAt: s.canceled_at,
    createdAt: s.created_at,
  }));

  const initialPayments = initial.map(p => ({
    paidAt: p.paid_at,
    amount: Number(p.amount) || 0,
    creditsAdded: Number(p.credits_per_month) || 0,
    source: 'initial',
    proposalId: p.proposal_id,
  }));
  const recurringPayments = recurring.map(p => ({
    paidAt: p.paid_at,
    amount: Number(p.amount) || 0,
    creditsAdded: Number(p.credits_per_month) || 0,
    source: 'recurring',
    proposalId: p.proposal_id,
  }));
  const payments = [...initialPayments, ...recurringPayments]
    .sort((a, b) => new Date(a.paidAt) - new Date(b.paidAt));

  const allocationList = allocations.map(a => ({
    id: a.id,
    proposalId: a.proposal_id,
    description: a.description,
    creditCost: Number(a.credit_cost) || 0,
    allocatedAt: a.allocated_at,
    allocatedBy: a.allocated_by,
    notes: a.notes,
  }));

  const issued = payments.reduce((s, p) => s + p.creditsAdded, 0);
  const used = allocationList.reduce((s, a) => s + a.creditCost, 0);
  const remaining = issued - used;
  const usagePct = issued > 0 ? Math.min(100, Math.round((used / issued) * 1000) / 10) : 0;

  const clientName = subscriptions.find(s => s.client_name)?.client_name
    || subs[0].proposalTitle
    || key;

  return res.status(200).json({
    clientKey: key,
    clientName,
    subscriptions: subs,
    payments,
    allocations: allocationList,
    totals: { issued, used, remaining, usagePct },
  });
}

async function logAllocation(req, res, user) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const clientKey = (body.clientKey || '').trim().toLowerCase();
  const description = (body.description || '').trim();
  const creditCost = Number(body.creditCost);
  const proposalId = body.proposalId ? String(body.proposalId) : null;
  const notes = body.notes ? String(body.notes).trim() : null;

  if (!clientKey)         return res.status(400).json({ error: 'clientKey required' });
  if (!description)       return res.status(400).json({ error: 'description required' });
  if (!Number.isFinite(creditCost) || creditCost <= 0) {
    return res.status(400).json({ error: 'creditCost must be a positive number' });
  }

  const [exists] = await sql`
    SELECT 1 FROM partner_subscriptions WHERE client_key = ${clientKey} LIMIT 1
  `;
  if (!exists) return res.status(404).json({ error: 'client not found' });

  const [row] = await sql`
    INSERT INTO credit_allocations
      (client_key, proposal_id, description, credit_cost, allocated_by, notes)
    VALUES
      (${clientKey}, ${proposalId}, ${description}, ${creditCost}, ${user.email || null}, ${notes})
    RETURNING id, client_key, proposal_id, description, credit_cost,
              allocated_at, allocated_by, notes
  `;

  return res.status(201).json({
    id: row.id,
    clientKey: row.client_key,
    proposalId: row.proposal_id,
    description: row.description,
    creditCost: Number(row.credit_cost) || 0,
    allocatedAt: row.allocated_at,
    allocatedBy: row.allocated_by,
    notes: row.notes,
  });
}

async function deleteAllocation(res, id) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return res.status(400).json({ error: 'invalid id' });
  }

  const result = await sql`DELETE FROM credit_allocations WHERE id = ${numeric} RETURNING id`;
  if (result.length === 0) return res.status(404).json({ error: 'not found' });

  return res.status(200).json({ ok: true, id: result[0].id });
}
