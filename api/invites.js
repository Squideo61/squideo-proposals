import crypto from 'node:crypto';
import sql from './_lib/db.js';
import { cors, requireAdmin } from './_lib/middleware.js';
import { sendMail, inviteHtml, APP_URL } from './_lib/email.js';

const EXPIRY_DAYS = 7;

function statusOf(row) {
  if (row.revoked_at) return 'revoked';
  if (row.used_at) return 'used';
  if (new Date(row.expires_at) < new Date()) return 'expired';
  return 'pending';
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.query.token ? String(req.query.token) : null;

  // Public preview — frontend uses this to pre-fill the signup email field.
  // Tokens are 32 random bytes so enumeration is infeasible.
  if (req.method === 'GET' && token) {
    const rows = await sql`SELECT email, role, expires_at, used_at, revoked_at FROM invites WHERE token = ${token}`;
    const inv = rows[0];
    if (!inv || inv.used_at || inv.revoked_at || new Date(inv.expires_at) < new Date()) {
      return res.status(404).json({ error: 'Invite not found or no longer valid' });
    }
    return res.status(200).json({ email: inv.email, role: inv.role, expiresAt: inv.expires_at });
  }

  if (req.method === 'DELETE' && token) {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const updated = await sql`UPDATE invites SET revoked_at = now()
      WHERE token = ${token} AND used_at IS NULL AND revoked_at IS NULL
      RETURNING token`;
    if (!updated.length) return res.status(404).json({ error: 'Invite not found or already used/revoked' });
    return res.status(200).json({ ok: true });
  }

  // Admin-only: list / create
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    const rows = await sql`SELECT token, email, invited_by_email, role, created_at, expires_at, used_at, revoked_at
                           FROM invites ORDER BY created_at DESC`;
    return res.status(200).json(rows.map(r => ({
      token: r.token,
      email: r.email,
      invitedByEmail: r.invited_by_email,
      role: r.role,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      usedAt: r.used_at,
      revokedAt: r.revoked_at,
      status: statusOf(r),
    })));
  }

  if (req.method === 'POST') {
    const { email, role } = req.body || {};
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
    const cleanEmail = email.trim().toLowerCase();
    const wantedRole = role === 'admin' ? 'admin' : 'member';

    const existingUser = await sql`SELECT email FROM users WHERE lower(email) = ${cleanEmail}`;
    if (existingUser.length) return res.status(409).json({ error: 'A user with that email already exists' });

    const livePending = await sql`SELECT token FROM invites
      WHERE lower(email) = ${cleanEmail} AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`;
    if (livePending.length) return res.status(409).json({ error: 'A pending invite for that email already exists. Revoke it first.' });

    const newToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

    await sql`INSERT INTO invites (token, email, invited_by_email, role, expires_at)
              VALUES (${newToken}, ${cleanEmail}, ${admin.email}, ${wantedRole}, ${expiresAt})`;

    const link = `${APP_URL}/?invite=${newToken}`;
    await sendMail({
      to: cleanEmail,
      subject: `You're invited to Squideo Proposals`,
      html: inviteHtml({ inviterName: admin.name, link, expiresInDays: EXPIRY_DAYS }),
      text: `${admin.name || 'A teammate'} has invited you to join Squideo Proposals. Accept here: ${link}`,
    });

    return res.status(201).json({
      token: newToken,
      email: cleanEmail,
      role: wantedRole,
      invitedByEmail: admin.email,
      expiresAt,
      status: 'pending',
      link,
    });
  }

  res.status(405).end();
}
