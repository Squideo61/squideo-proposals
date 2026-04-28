import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  const { id } = req.query;

  if (req.method === 'PUT') {
    const data = req.body;
    await sql`
      INSERT INTO templates (id, data)
      VALUES (${id}, ${JSON.stringify(data)})
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
    `;
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    await sql`DELETE FROM templates WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
}
