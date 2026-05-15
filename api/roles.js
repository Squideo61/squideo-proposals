// /api/roles — CRUD for the roles table.
//
// GET                : every authed user (UI needs role names for badges)
// POST / PATCH / DELETE : require `roles.manage` permission
//
// System roles ('admin', 'member') can be edited but not deleted, and their
// id cannot be renamed (the FK on users.role would block the cascade if we
// tried). Adding new roles invents a fresh slug from the supplied name.

import sql from './_lib/db.js';
import { cors, requireAuth, requirePermission } from './_lib/middleware.js';
import { listRoles, invalidateRoleCache, getRole } from './_lib/userRoles.js';
import { PERMISSIONS, isValidPermission } from './_lib/permissions.js';
import { NOTIFICATIONS, isValidNotificationKey } from './_lib/notifications.js';

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'role';
}

function cleanPermissions(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const slug of input) {
    if (typeof slug !== 'string') continue;
    if (!isValidPermission(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

function cleanNotificationDefaults(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of Object.keys(input)) {
    if (!isValidNotificationKey(key)) continue;
    out[key] = !!input[key];
  }
  // Fill missing keys with false so a UI render later doesn't see undefined.
  for (const n of NOTIFICATIONS) {
    if (!(n.key in out)) out[n.key] = false;
  }
  return out;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const payload = await requireAuth(req, res);
    if (!payload) return;
    const rows = await listRoles();
    return res.status(200).json(rows);
  }

  if (req.method === 'POST') {
    const payload = await requirePermission(req, res, 'roles.manage');
    if (!payload) return;
    const { name, permissions, notificationDefaults } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Role name is required' });
    }
    // Pick a unique slug derived from the name.
    let base = slugify(name);
    let id = base;
    let n = 2;
    /* eslint-disable no-await-in-loop */
    while (await getRole(id)) {
      id = `${base}_${n++}`;
      if (n > 100) return res.status(500).json({ error: 'Could not generate a unique role id' });
    }
    /* eslint-enable no-await-in-loop */
    const perms = cleanPermissions(permissions);
    const defs = cleanNotificationDefaults(notificationDefaults);
    await sql`
      INSERT INTO roles (id, name, permissions, notification_defaults, is_system)
      VALUES (${id}, ${name.trim()}, ${JSON.stringify(perms)}::jsonb, ${JSON.stringify(defs)}::jsonb, false)
    `;
    invalidateRoleCache();
    const created = await getRole(id);
    return res.status(201).json(created);
  }

  if (req.method === 'PATCH') {
    const payload = await requirePermission(req, res, 'roles.manage');
    if (!payload) return;
    const id = req.query.id ? String(req.query.id) : null;
    if (!id) return res.status(400).json({ error: 'Missing role id' });
    const existing = await getRole(id);
    if (!existing) return res.status(404).json({ error: 'Role not found' });

    const { name, permissions, notificationDefaults } = req.body || {};
    const updates = {};
    if (typeof name === 'string' && name.trim()) updates.name = name.trim();
    if (Array.isArray(permissions)) updates.permissions = cleanPermissions(permissions);
    if (notificationDefaults && typeof notificationDefaults === 'object') {
      updates.notification_defaults = cleanNotificationDefaults(notificationDefaults);
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    await sql`
      UPDATE roles SET
        name                  = COALESCE(${updates.name ?? null}, name),
        permissions           = COALESCE(${updates.permissions ? JSON.stringify(updates.permissions) : null}::jsonb, permissions),
        notification_defaults = COALESCE(${updates.notification_defaults ? JSON.stringify(updates.notification_defaults) : null}::jsonb, notification_defaults),
        updated_at            = NOW()
      WHERE id = ${id}
    `;
    invalidateRoleCache(id);
    const updated = await getRole(id);
    return res.status(200).json(updated);
  }

  if (req.method === 'DELETE') {
    const payload = await requirePermission(req, res, 'roles.manage');
    if (!payload) return;
    const id = req.query.id ? String(req.query.id) : null;
    if (!id) return res.status(400).json({ error: 'Missing role id' });
    const existing = await getRole(id);
    if (!existing) return res.status(404).json({ error: 'Role not found' });
    if (existing.is_system) return res.status(400).json({ error: 'System roles cannot be deleted' });

    // Block deletion while users still reference the role — the FK would
    // reject the DELETE anyway but we want a friendlier error than the raw
    // PG message.
    const usersWithRole = await sql`SELECT COUNT(*)::int AS n FROM users WHERE role = ${id}`;
    if (usersWithRole[0].n > 0) {
      return res.status(409).json({
        error: `Cannot delete role: ${usersWithRole[0].n} user(s) still have it. Reassign them first.`,
        code: 'role-in-use',
        usersCount: usersWithRole[0].n,
      });
    }
    await sql`DELETE FROM roles WHERE id = ${id}`;
    invalidateRoleCache(id);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}

// Re-export the catalog for any UI that fetches it via this endpoint shape.
export { PERMISSIONS, NOTIFICATIONS };
