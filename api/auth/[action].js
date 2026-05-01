import bcrypt from 'bcryptjs';
import sql from '../_lib/db.js';
import { signToken } from '../_lib/auth.js';
import { cors } from '../_lib/middleware.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { action } = req.query;

  if (action === 'login') {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const rows = await sql`SELECT email, name, avatar, role, password_hash FROM users WHERE email = ${email}`;
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const role = user.role || 'member';
    const token = await signToken({ email: user.email, name: user.name, role });
    return res.status(200).json({ token, user: { email: user.email, name: user.name, avatar: user.avatar, role } });
  }

  if (action === 'signup') {
    const { email, name, password, inviteToken } = req.body;
    if (!email || !name || !password) return res.status(400).json({ error: 'email, name and password are required' });
    const token = (inviteToken || '').trim();
    if (!token) return res.status(400).json({ error: 'An invite is required to create an account' });

    const inv = (await sql`SELECT email, role, expires_at, used_at, revoked_at FROM invites WHERE token = ${token}`)[0];
    if (!inv || inv.used_at || inv.revoked_at || new Date(inv.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired invite' });
    }
    if (inv.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
      return res.status(400).json({ error: 'Email does not match invite' });
    }

    const existing = await sql`SELECT email FROM users WHERE lower(email) = ${email.toLowerCase()}`;
    if (existing.length > 0) return res.status(409).json({ error: 'An account with that email already exists' });

    const consumed = await sql`UPDATE invites SET used_at = now()
      WHERE token = ${token} AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      RETURNING role`;
    if (!consumed.length) return res.status(409).json({ error: 'Invite already used' });
    const role = consumed[0].role || 'member';

    const password_hash = await bcrypt.hash(password, 10);
    await sql`INSERT INTO users (email, name, password_hash, role) VALUES (${email}, ${name}, ${password_hash}, ${role})`;

    const jwt = await signToken({ email, name, role });
    return res.status(201).json({ token: jwt, user: { email, name, avatar: null, role } });
  }

  res.status(404).end();
}
