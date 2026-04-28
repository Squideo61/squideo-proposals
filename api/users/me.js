import bcrypt from 'bcryptjs';
import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = await requireAuth(req, res);
  if (!payload) return;

  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).end();
  }

  const { avatar, current_password, new_password } = req.body;

  if (new_password !== undefined) {
    if (!current_password) return res.status(400).json({ error: 'Current password is required' });
    if (new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    const rows = await sql`SELECT password_hash FROM users WHERE email = ${payload.email}`;
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(new_password, 10);
    await sql`UPDATE users SET password_hash = ${hash} WHERE email = ${payload.email}`;
    return res.status(200).json({ ok: true });
  }

  if (avatar !== undefined) {
    await sql`UPDATE users SET avatar = ${avatar || null} WHERE email = ${payload.email}`;
    return res.status(200).json({ ok: true });
  }

  res.status(400).json({ error: 'Nothing to update' });
}
