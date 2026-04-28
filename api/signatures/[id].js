import sql from '../_lib/db.js';
import { cors } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;

  if (req.method === 'GET') {
    const rows = await sql`SELECT name, email, signed_at, data FROM signatures WHERE proposal_id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const row = rows[0];
    return res.status(200).json({ name: row.name, email: row.email, signedAt: row.signed_at, ...row.data });
  }

  if (req.method === 'POST') {
    const { name, email, signedAt, ...rest } = req.body;
    await sql`
      INSERT INTO signatures (proposal_id, name, email, signed_at, data)
      VALUES (${id}, ${name}, ${email}, ${signedAt}, ${JSON.stringify(rest)})
      ON CONFLICT (proposal_id) DO UPDATE
        SET name = EXCLUDED.name, email = EXCLUDED.email,
            signed_at = EXCLUDED.signed_at, data = EXCLUDED.data
    `;
    return res.status(201).json({ ok: true });
  }

  res.status(405).end();
}
