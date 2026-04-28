import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const rows = await sql`SELECT email, name, avatar, created_at FROM users ORDER BY created_at ASC`;
    const users = {};
    for (const row of rows) {
      users[row.email] = { email: row.email, name: row.name, avatar: row.avatar, createdAt: row.created_at };
    }
    return res.status(200).json(users);
  }

  res.status(405).end();
}
