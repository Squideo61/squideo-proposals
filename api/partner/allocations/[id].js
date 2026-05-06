// DELETE /api/partner/allocations/[id] — admin: remove a logged allocation.
import sql from '../../_lib/db.js';
import { cors, requireAuth } from '../../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'DELETE') return res.status(405).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  const { id } = req.query;
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return res.status(400).json({ error: 'invalid id' });
  }

  const result = await sql`DELETE FROM credit_allocations WHERE id = ${numeric} RETURNING id`;
  if (result.length === 0) return res.status(404).json({ error: 'not found' });

  return res.status(200).json({ ok: true, id: result[0].id });
}
