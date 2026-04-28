import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const rows = await sql`SELECT id, data, created_at, updated_at FROM proposals ORDER BY created_at DESC`;
    const proposals = {};
    for (const row of rows) {
      proposals[row.id] = { ...row.data, _createdAt: row.created_at };
    }
    return res.status(200).json(proposals);
  }

  res.status(405).end();
}
