// Session-token revocation. Session JWTs carry a `tv` (token version) claim that
// must match the user's current `users.token_version`. Bumping a user's version
// invalidates every JWT issued before the bump — used for password change, 2FA
// reset and an explicit "sign out everywhere". Stateless JWT verification stays
// in api/_lib/auth.js; this adds the one DB-backed liveness check on top.
import sql from './db.js';

// Self-heal the column so a workspace that skipped the migration still works.
// Module-cached: a successful first call short-circuits the rest.
let ensured = null;
function ensureTokenVersionColumn() {
  if (ensured) return ensured;
  ensured = sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0`
    .then(() => {}).catch((err) => { ensured = null; throw err; });
  return ensured;
}

// Current token version for a user, or null if the user no longer exists (a
// valid JWT for a deleted account must be rejected).
export async function getTokenVersion(email) {
  await ensureTokenVersionColumn();
  const rows = await sql`SELECT token_version FROM users WHERE email = ${email}`;
  return rows.length ? (rows[0].token_version || 0) : null;
}

// Invalidate all of a user's existing sessions by advancing their version.
// Returns the new version so the caller can re-issue the current session.
export async function bumpTokenVersion(email) {
  await ensureTokenVersionColumn();
  const rows = await sql`
    UPDATE users SET token_version = COALESCE(token_version, 0) + 1
    WHERE email = ${email}
    RETURNING token_version`;
  return rows.length ? rows[0].token_version : null;
}
