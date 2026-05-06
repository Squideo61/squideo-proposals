import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  // [[...slug]] is an optional catch-all — `slug` is undefined for the
  // collection route (/api/templates) and an array like ['abc'] for the
  // item route (/api/templates/abc).
  const slug = req.query.slug;
  const id = Array.isArray(slug) ? slug[0] : (typeof slug === 'string' ? slug : null);

  if (!id) {
    if (req.method === 'GET') {
      const rows = await sql`SELECT id, data FROM templates ORDER BY created_at DESC`;
      const templates = {};
      for (const row of rows) templates[row.id] = row.data;
      return res.status(200).json(templates);
    }
    return res.status(405).end();
  }

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
