// Role lookup helper. Cached per request because requirePermission may run
// multiple times in one handler (rare, but cheap to memoise).
//
// Why this isn't in middleware.js: the `roles` table is also queried by the
// notification resolver in api/_lib/notifications.js — keeping the SQL here
// means both modules import from the same source and the cache is shared.

import sql from './db.js';

// Module-level cache. Fine because Vercel serverless instances are
// short-lived; the cache vacuums itself on cold start. Roles change rarely
// (only via the admin UI) so a 60s TTL is plenty even on warm instances.
const ROLE_CACHE = new Map(); // id -> { row, cachedAt }
const ROLE_TTL_MS = 60_000;

function fresh(entry) {
  return entry && (Date.now() - entry.cachedAt) < ROLE_TTL_MS;
}

export async function getRole(id) {
  if (!id) return null;
  const cached = ROLE_CACHE.get(id);
  if (fresh(cached)) return cached.row;
  const rows = await sql`SELECT id, name, permissions, notification_defaults, is_system FROM roles WHERE id = ${id} LIMIT 1`;
  const row = rows[0] || null;
  ROLE_CACHE.set(id, { row, cachedAt: Date.now() });
  return row;
}

// Self-heal for system roles added after the initial roles seed (currently the
// 'copywriter' role — same permissions as Producer for now). Idempotent and
// module-level cached. Called by listRoles AND the /me permissions path so the
// role + its permissions are correct even if the migration wasn't applied.
let systemRolesEnsured = null;
export function ensureSystemRoles() {
  if (systemRolesEnsured) return systemRolesEnsured;
  systemRolesEnsured = (async () => {
    try {
      await sql`
        INSERT INTO roles (id, name, permissions, notification_defaults, is_system)
        VALUES ('copywriter', 'Copywriter', '["revisions.access", "production.access"]'::jsonb, '{}'::jsonb, true)
        ON CONFLICT (id) DO NOTHING
      `;
      // Back-fill finance.manage on a Director role that pre-dates the permission
      // (the 20260609 migration is ON CONFLICT DO NOTHING, so it won't update an
      // existing role). Without this, Directors can't reach the Finance section.
      const upd = await sql`
        UPDATE roles
           SET permissions = permissions || '["finance.manage"]'::jsonb, updated_at = NOW()
         WHERE id = 'director' AND NOT (permissions @> '["finance.manage"]'::jsonb)
      `;
      if ((upd.count || upd.rowCount || 0) > 0) invalidateRoleCache('director');
    } catch (err) {
      systemRolesEnsured = null;
      console.warn('[roles] ensure system roles failed', err.message);
    }
  })();
  return systemRolesEnsured;
}

// List every role. Not cached — the admin UI hits this rarely and freshness
// matters more than the saved query.
export async function listRoles() {
  await ensureSystemRoles();
  const rows = await sql`
    SELECT id, name, permissions, notification_defaults, is_system, created_at, updated_at
      FROM roles
     ORDER BY is_system DESC, name ASC
  `;
  return rows;
}

// Drop the cache. Called by the roles API when an admin saves changes so
// permission checks on subsequent requests see the new state.
export function invalidateRoleCache(id = null) {
  if (id) ROLE_CACHE.delete(id);
  else ROLE_CACHE.clear();
}

// Convenience: get the role row for a user (looks up users.role first, then
// the role row). Returns null if the user doesn't exist or has no role.
export async function getRoleForUser(email) {
  if (!email) return null;
  const rows = await sql`SELECT role FROM users WHERE email = ${email} LIMIT 1`;
  if (!rows[0]) return null;
  return getRole(rows[0].role);
}
