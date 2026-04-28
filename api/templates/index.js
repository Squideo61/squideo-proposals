import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const rows = await sql`SELECT id, data FROM templates ORDER BY created_at DESC`;
    const templates = {};
    for (const row of rows) {
      templates[row.id] = row.data;
    }
    return res.status(200).json(templates);
  }

  res.status(405).end();
}
