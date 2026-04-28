import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;

  // GET is public so clients can view their proposal
  if (req.method === 'GET') {
    const rows = await sql`SELECT data FROM proposals WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json(rows[0].data);
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  if (req.method === 'PUT') {
    const data = req.body;
    await sql`
      INSERT INTO proposals (id, data, updated_at)
      VALUES (${id}, ${JSON.stringify(data)}, NOW())
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
    `;
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    await sql`DELETE FROM proposals WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
}
