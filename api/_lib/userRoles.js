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
      // Marketing role: a scoped shell that only sees the Marketing section.
      await sql`
        INSERT INTO roles (id, name, permissions, notification_defaults, is_system)
        VALUES ('marketing', 'Marketing', '["marketing.access"]'::jsonb, '{}'::jsonb, true)
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

      // The £ (sales & finance) notifications bell is for Admin (covered by '*'),
      // Directors and Project Managers (role id 'member'). Back-fill the gating
      // permission onto the latter two so the bell appears without a migration.
      const fnUpd = await sql`
        UPDATE roles
           SET permissions = permissions || '["finance.notifications"]'::jsonb, updated_at = NOW()
         WHERE id IN ('director', 'member') AND NOT (permissions @> '["finance.notifications"]'::jsonb)
      `;
      if ((fnUpd.count || fnUpd.rowCount || 0) > 0) invalidateRoleCache();

      // Pending Payments view + predicting — for Project/Production Managers
      // (role 'member'), so they can see all pending payments and flag any as
      // predicted without the full business-finance grant. Back-filled so it
      // applies without a migration.
      const ppUpd = await sql`
        UPDATE roles
           SET permissions = permissions || '["finance.pending_payments"]'::jsonb, updated_at = NOW()
         WHERE id = 'member' AND NOT (permissions @> '["finance.pending_payments"]'::jsonb)
      `;
      if ((ppUpd.count || ppUpd.rowCount || 0) > 0) invalidateRoleCache('member');

      // The "pending payment marked paid" alert is a new broadcast key — default
      // it ON for Admin / Director / Project Manager so they actually receive it
      // (a key absent from notification_defaults resolves to OFF).
      await sql`
        UPDATE roles
           SET notification_defaults = notification_defaults || '{"pp.marked_paid": true}'::jsonb, updated_at = NOW()
         WHERE id IN ('admin', 'director', 'member') AND NOT (notification_defaults ? 'pp.marked_paid')
      `;

      // "Project good to go" — fired when a sold deal is marked good to go and
      // moves into production. Default ON for Admin / Director / Project Manager
      // (role 'member') so the people who run production actually hear about it.
      await sql`
        UPDATE roles
           SET notification_defaults = notification_defaults || '{"project.good_to_go": true}'::jsonb, updated_at = NOW()
         WHERE id IN ('admin', 'director', 'member') AND NOT (notification_defaults ? 'project.good_to_go')
      `;

      // ── Producer schedule + annual leave ──
      // Everyone who works production can see their own calendar and book leave;
      // only Admins + Directors manage the master schedule and approve leave.
      const schedAccess = await sql`
        UPDATE roles
           SET permissions = permissions || '["schedule.access"]'::jsonb, updated_at = NOW()
         WHERE id IN ('producer', 'copywriter', 'member', 'director') AND NOT (permissions @> '["schedule.access"]'::jsonb)
      `;
      if ((schedAccess.count || schedAccess.rowCount || 0) > 0) invalidateRoleCache();
      // Weekly-schedule management (see all producers + Master + drag/assign/
      // durations) → Directors AND Project/Production Managers (role 'member',
      // e.g. Callum). Admins get it via '*'.
      const schedManage = await sql`
        UPDATE roles
           SET permissions = permissions || '["schedule.manage"]'::jsonb, updated_at = NOW()
         WHERE id IN ('director', 'member') AND NOT (permissions @> '["schedule.manage"]'::jsonb)
      `;
      if ((schedManage.count || schedManage.rowCount || 0) > 0) invalidateRoleCache();
      // Approving annual leave → Directors AND Project/Production Managers (role
      // 'member', e.g. Callum), since they run the rota. Admins via '*'.
      const schedApprove = await sql`
        UPDATE roles
           SET permissions = permissions || '["schedule.approve_leave"]'::jsonb, updated_at = NOW()
         WHERE id IN ('director', 'member') AND NOT (permissions @> '["schedule.approve_leave"]'::jsonb)
      `;
      if ((schedApprove.count || schedApprove.rowCount || 0) > 0) invalidateRoleCache();
      // Editing allowances (entitlements, renewal dates, days used) stays tighter:
      // Directors only (Admins via '*'). Production managers approve leave but
      // don't set holiday entitlements.
      const schedAllowance = await sql`
        UPDATE roles
           SET permissions = permissions || '["schedule.manage_allowance"]'::jsonb, updated_at = NOW()
         WHERE id = 'director' AND NOT (permissions @> '["schedule.manage_allowance"]'::jsonb)
      `;
      if ((schedAllowance.count || schedAllowance.rowCount || 0) > 0) invalidateRoleCache('director');
      // Leave-request approvals → Admins & Directors.
      await sql`
        UPDATE roles
           SET notification_defaults = notification_defaults || '{"leave.requested": true}'::jsonb, updated_at = NOW()
         WHERE id IN ('admin', 'director') AND NOT (notification_defaults ? 'leave.requested')
      `;
      // Schedule clashes go to Project/Production Managers (role 'member') only —
      // they run the weekly schedule and are the ones who rearrange it. Seed the
      // default ON for them.
      await sql`
        UPDATE roles
           SET notification_defaults = notification_defaults || '{"schedule.conflict": true}'::jsonb, updated_at = NOW()
         WHERE id = 'member' AND NOT (notification_defaults ? 'schedule.conflict')
      `;
      // Admins & Directors were previously defaulted ON for schedule clashes.
      // Turn the default OFF for them, once. Guarded by a sentinel key so an
      // admin who later re-enables it on the role in the UI isn't overridden on
      // the next cold start.
      await sql`
        UPDATE roles
           SET notification_defaults = notification_defaults
                                     || '{"schedule.conflict": false, "_schedule_conflict_pm_only": true}'::jsonb,
               updated_at = NOW()
         WHERE id IN ('admin', 'director') AND NOT (notification_defaults ? '_schedule_conflict_pm_only')
      `;
      // A leave decision reaches the requester — default ON for every role that
      // can book leave (plus Admin, covered by '*').
      await sql`
        UPDATE roles
           SET notification_defaults = notification_defaults || '{"leave.decided": true}'::jsonb, updated_at = NOW()
         WHERE id IN ('producer', 'copywriter', 'member', 'director', 'admin') AND NOT (notification_defaults ? 'leave.decided')
      `;
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
