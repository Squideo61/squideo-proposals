// GET /api/partner/clients/[key] — admin: per-client credits detail.
import sql from '../../_lib/db.js';
import { cors, requireAuth } from '../../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  const { key } = req.query;
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

  const clientName = subs[0].proposalTitle
    || subscriptions.find(s => s.client_name)?.client_name
    || key;

  return res.status(200).json({
    clientKey: key,
    clientName: subscriptions.find(s => s.client_name)?.client_name || clientName,
    subscriptions: subs,
    payments,
    allocations: allocationList,
    totals: { issued, used, remaining, usagePct },
  });
}
