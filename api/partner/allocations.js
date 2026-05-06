// POST /api/partner/allocations — admin: log a work allocation against a client's credits.
import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const user = await requireAuth(req, res);
  if (!user) return;

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

  // Confirm the client exists in our subscriptions table — prevents typos
  // creating orphan allocations.
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
