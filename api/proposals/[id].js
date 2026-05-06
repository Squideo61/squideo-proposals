import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;

  // GET is public so clients can view their proposal
  if (req.method === 'GET') {
    const rows = await sql`
      SELECT data, number_year, number_seq
      FROM proposals WHERE id = ${id}
    `;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    return res.status(200).json({
      ...r.data,
      _number: r.number_year && r.number_seq ? { year: r.number_year, seq: r.number_seq } : null,
    });
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  if (req.method === 'PUT') {
    const data = req.body;
    const y = new Date().getFullYear();
    await sql`
      INSERT INTO proposals (id, data, updated_at, number_year, number_seq)
      VALUES (
        ${id}, ${JSON.stringify(data)}, NOW(), ${y},
        COALESCE(
          (SELECT MAX(number_seq) + 1 FROM proposals WHERE number_year = ${y}),
          1
        )
      )
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
    `;
    const rows = await sql`SELECT number_year, number_seq FROM proposals WHERE id = ${id}`;
    const n = rows[0];
    return res.status(200).json({
      ok: true,
      number: n && n.number_year && n.number_seq ? { year: n.number_year, seq: n.number_seq } : null,
    });
  }

  if (req.method === 'DELETE') {
    await sql`DELETE FROM proposals WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
}
