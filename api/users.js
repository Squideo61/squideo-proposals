// /api/users — admin user management.
// /api/invites — admin invite management. Routed here via vercel.json
// rewrite that adds `_kind=invites` so the same serverless function handles
// both URL prefixes (saves a slot under the Hobby 12-function cap).
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import sql from './_lib/db.js';
import { cors, requireAuth, requireAdmin, requirePermission } from './_lib/middleware.js';
import { sendMail, inviteHtml, APP_URL } from './_lib/email.js';
import { getRole } from './_lib/userRoles.js';
import { hasPermission } from './_lib/permissions.js';
import { getEffectivePrefs } from './_lib/notifications.js';
import { NOTIFICATIONS, isValidNotificationKey } from './_lib/notificationsCatalog.js';

const INVITE_EXPIRY_DAYS = 7;

function inviteStatus(row) {
  if (row.revoked_at) return 'revoked';
  if (row.used_at) return 'used';
  if (new Date(row.expires_at) < new Date()) return 'expired';
  return 'pending';
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.query._kind === 'invites') {
    return invitesHandler(req, res);
  }
  if (req.query._kind === 'notifications') {
    return notificationsHandler(req, res);
  }
  return usersHandler(req, res);
}

async function usersHandler(req, res) {
  if (req.method === 'GET') {
    const payload = await requireAuth(req, res);
    if (!payload) return;
    const rows = await sql`SELECT email, name, avatar, role, created_at FROM users ORDER BY created_at ASC`;
    const users = {};
    for (const row of rows) {
      users[row.email] = { email: row.email, name: row.name, avatar: row.avatar, role: row.role || 'member', createdAt: row.created_at };
    }
    return res.status(200).json(users);
  }

  if (req.method === 'PATCH') {
    const payload = await requireAuth(req, res);
    if (!payload) return;
    const { avatar, current_password, new_password, role: newRole, email: targetEmail } = req.body || {};

    // Role change: targets a (possibly different) user. Requires users.manage
    // on the caller's role and that the target email is not the caller's own
    // (admins can't demote themselves into a role with no permissions and get
    // locked out).
    if (newRole !== undefined) {
      const role = await getRole(payload.role);
      if (!hasPermission(role, 'users.manage')) {
        return res.status(403).json({ error: 'You do not have permission to change roles' });
      }
      const targetEmailLower = (targetEmail || payload.email).toLowerCase();
      if (targetEmailLower === payload.email.toLowerCase()) {
        return res.status(400).json({ error: "You can't change your own role." });
      }
      const newRoleRow = await getRole(newRole);
      if (!newRoleRow) return res.status(400).json({ error: 'Unknown role' });
      const targetRows = await sql`SELECT email FROM users WHERE email = ${targetEmailLower}`;
      if (!targetRows[0]) return res.status(404).json({ error: 'User not found' });
      await sql`UPDATE users SET role = ${newRole} WHERE email = ${targetEmailLower}`;
      return res.status(200).json({ ok: true, email: targetEmailLower, role: newRole });
    }

    if (new_password !== undefined) {
      if (!current_password) return res.status(400).json({ error: 'Current password is required' });
      if (new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
      const rows = await sql`SELECT password_hash FROM users WHERE email = ${payload.email}`;
      if (!rows[0]) return res.status(404).json({ error: 'User not found' });
      const valid = await bcrypt.compare(current_password, rows[0].password_hash);
      if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });
      const hash = await bcrypt.hash(new_password, 12);
      await sql`UPDATE users SET password_hash = ${hash} WHERE email = ${payload.email}`;
      return res.status(200).json({ ok: true });
    }

    if (avatar !== undefined) {
      // Cap the data URL string at ~7.5 MB so a malicious caller can't bloat
      // the DB (5 MB image binary ≈ 6.7 MB base64; small headroom for prefix).
      if (typeof avatar === 'string' && avatar.length > 7_500_000) {
        return res.status(413).json({ error: 'Avatar too large (max 5 MB)' });
      }
      await sql`UPDATE users SET avatar = ${avatar || null} WHERE email = ${payload.email}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Nothing to update' });
  }

  if (req.method === 'DELETE') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const email = req.query.email ? String(req.query.email) : null;
    if (!email) return res.status(400).json({ error: 'email query parameter is required' });
    if (email === admin.email) return res.status(400).json({ error: 'You cannot delete your own account' });
    await sql`DELETE FROM users WHERE email = ${email}`;
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
}

// /api/users?_kind=notifications&email=... — get / set a user's notification
// overrides. Caller may always read/write their own; others require users.manage.
async function notificationsHandler(req, res) {
  const payload = await requireAuth(req, res);
  if (!payload) return;

  const targetEmail = ((req.query.email ? String(req.query.email) : payload.email) || '').toLowerCase();
  const isSelf = targetEmail === payload.email.toLowerCase();

  if (!isSelf) {
    const role = await getRole(payload.role);
    if (!hasPermission(role, 'users.manage')) {
      return res.status(403).json({ error: 'You can only edit your own notification settings' });
    }
  }

  const targetRows = await sql`SELECT email, role FROM users WHERE email = ${targetEmail}`;
  if (!targetRows[0]) return res.status(404).json({ error: 'User not found' });

  if (req.method === 'GET') {
    const effective = await getEffectivePrefs(targetEmail);
    const overrideRows = await sql`SELECT notification_key, enabled FROM user_notification_overrides WHERE user_email = ${targetEmail}`;
    const overrides = {};
    for (const row of overrideRows) overrides[row.notification_key] = row.enabled;
    return res.status(200).json({
      email: targetEmail,
      role: targetRows[0].role,
      effective,
      overrides,
    });
  }

  if (req.method === 'PUT') {
    const { overrides } = req.body || {};
    if (!overrides || typeof overrides !== 'object') {
      return res.status(400).json({ error: 'Expected `overrides` object' });
    }
    // The contract is: caller sends the full set of overrides they want to
    // exist. Anything missing is removed; anything `null` is removed; the
    // rest is upserted. This makes the PUT idempotent.
    const keep = {}; // key -> bool
    for (const key of Object.keys(overrides)) {
      if (!isValidNotificationKey(key)) continue;
      const v = overrides[key];
      if (v === null || v === undefined) continue;
      keep[key] = !!v;
    }
    await sql`DELETE FROM user_notification_overrides WHERE user_email = ${targetEmail}`;
    for (const [key, val] of Object.entries(keep)) {
      // eslint-disable-next-line no-await-in-loop
      await sql`
        INSERT INTO user_notification_overrides (user_email, notification_key, enabled, updated_at)
        VALUES (${targetEmail}, ${key}, ${val}, NOW())
      `;
    }
    const effective = await getEffectivePrefs(targetEmail);
    return res.status(200).json({ ok: true, effective, overrides: keep });
  }

  return res.status(405).end();
}

async function invitesHandler(req, res) {
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
      status: inviteStatus(r),
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
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

    await sql`INSERT INTO invites (token, email, invited_by_email, role, expires_at)
              VALUES (${newToken}, ${cleanEmail}, ${admin.email}, ${wantedRole}, ${expiresAt})`;

    const link = `${APP_URL}/?invite=${newToken}`;
    await sendMail({
      to: cleanEmail,
      subject: `You're invited to Squideo CRM`,
      html: inviteHtml({ inviterName: admin.name, link, expiresInDays: INVITE_EXPIRY_DAYS }),
      text: `${admin.name || 'A teammate'} has invited you to join Squideo CRM. Accept here: ${link}`,
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
