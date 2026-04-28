import bcrypt from 'bcryptjs';
import sql from '../_lib/db.js';
import { signToken } from '../_lib/auth.js';
import { cors } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const rows = await sql`SELECT email, name, avatar, password_hash FROM users WHERE email = ${email}`;
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

  const token = await signToken({ email: user.email, name: user.name });
  res.status(200).json({ token, user: { email: user.email, name: user.name, avatar: user.avatar } });
}
