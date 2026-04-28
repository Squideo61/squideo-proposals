import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  const { email } = req.query;

  if (req.method === 'DELETE') {
    if (email === user.email) return res.status(400).json({ error: 'You cannot delete your own account' });
    await sql`DELETE FROM users WHERE email = ${email}`;
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
}
