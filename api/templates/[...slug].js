import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  // Parse the template id from req.url directly (Vercel's req.query.slug has
  // proven unreliable for non-optional catch-all routes). The parent route
  // /api/templates is rewritten in vercel.json to /api/templates/_root, which
  // we treat as the no-id collection request.
  const urlPath = (req.url || '').split('?')[0];
  const segs = urlPath.split('/').filter(Boolean).slice(2); // strip 'api', 'templates'
  const first = segs[0] || null;
  const id = first === '_root' ? null : first;

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
