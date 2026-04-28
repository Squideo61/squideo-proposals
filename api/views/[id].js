import sql from '../_lib/db.js';
import { cors } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;

  if (req.method === 'POST') {
    await sql`
      INSERT INTO views (proposal_id, viewed_at)
      VALUES (${id}, NOW())
      ON CONFLICT (proposal_id) DO NOTHING
    `;
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
}
