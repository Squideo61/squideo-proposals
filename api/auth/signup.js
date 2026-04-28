import bcrypt from 'bcryptjs';
import sql from '../_lib/db.js';
import { signToken } from '../_lib/auth.js';
import { cors } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { email, name, password } = req.body;
  if (!email || !name || !password) return res.status(400).json({ error: 'email, name and password are required' });

  const existing = await sql`SELECT email FROM users WHERE email = ${email}`;
  if (existing.length > 0) return res.status(409).json({ error: 'An account with that email already exists' });

  const password_hash = await bcrypt.hash(password, 10);
  await sql`INSERT INTO users (email, name, password_hash) VALUES (${email}, ${name}, ${password_hash})`;

  const token = await signToken({ email, name });
  res.status(201).json({ token, user: { email, name, avatar: null } });
}
