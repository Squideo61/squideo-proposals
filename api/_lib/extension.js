// Validates an opaque extension bearer token against the extension_tokens
// table. Returns the same payload shape as verifyToken (the session JWT) so
// requireAuth() can transparently accept either.
import sql from './db.js';

export async function lookupExtensionToken(token) {
  if (!token) return null;
  const rows = await sql`
    SELECT et.user_email, u.name, u.role
    FROM extension_tokens et
    JOIN users u ON u.email = et.user_email
    WHERE et.token = ${token}
      AND et.revoked_at IS NULL
      AND et.expires_at > NOW()
    LIMIT 1
  `;
  if (!rows.length) return null;
  // Fire-and-forget last_seen_at stamp so we don't block the request.
  // Failures here are non-fatal — the token still works.
  sql`UPDATE extension_tokens SET last_seen_at = NOW() WHERE token = ${token}`
    .catch(err => console.warn('[extension token last_seen update]', err.message));
  return {
    email: rows[0].user_email,
    name: rows[0].name,
    role: rows[0].role,
    via: 'extension-token',
  };
}
