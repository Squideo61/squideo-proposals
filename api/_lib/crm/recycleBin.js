// Recycle bin for undoable hard-deletes. Instead of soft-delete columns on every
// table (which would mean adding `deleted_at IS NULL` to ~180 read queries and
// risking a deleted row leaking into one of them), we archive the full row(s)
// just before a hard delete and re-insert them — with the SAME id — on restore.
//
// This keeps every existing query correct (the row really is gone) and keeps ids
// stable, so the CRM undo/redo can delete → restore → delete cleanly. Only used
// for entities with no external FK references to lose (tasks, manual pending
// payments). Heavier entities (deals/contacts/companies) need link-aware restore
// and are intentionally not handled here.

import sql from '../db.js';
import { makeId } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';

// Restore must mirror the permission that gated the original delete, so a low-
// privilege account can't resurrect records it could never have removed. Keyed
// by the `entity` label passed to archiveRecord(). Entities whose delete was
// gated by an ownership check (tasks: creator / assignee / tasks.manage_all)
// additionally allow the original deleter to undo — see restoreRoute.
const RESTORE_PERMISSION = {
  task:          'tasks.manage_all',
  manual_pp:     'finance.manage',
  cashflow_cost: 'finance.manage',
  project_video: 'production.access',
};
// Entities whose delete allowed the row's owner (not just a permission holder).
// For these, the original deleter may always restore their own deletion.
const OWNER_RESTORABLE = new Set(['task']);

// Tables we allow restoring into. The table name can't be parameterised in the
// json_populate_record call, so it must come from this fixed allowlist.
const RESTORABLE_TABLES = new Set([
  'tasks', 'task_assignees', 'manual_pending_payments', 'cashflow_costs',
  // Production video + its cascade children (re-inserted parent-first on restore).
  'project_videos', 'video_milestones', 'video_milestone_assets', 'video_scripts', 'video_assignees',
]);

let ensured = null;
export function ensureDeletedRecords() {
  if (ensured) return ensured;
  ensured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS deleted_records (
        id          TEXT PRIMARY KEY,
        entity      TEXT NOT NULL,
        record_id   TEXT NOT NULL,
        payload     JSONB NOT NULL,
        deleted_by  TEXT,
        deleted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS deleted_records_record_idx ON deleted_records(record_id)`;
  })().catch((err) => { ensured = null; throw err; });
  return ensured;
}

// Archive a set of rows for one logical record before deleting it. `rows` is an
// ordered list of { table, row } — re-inserted in this order on restore, so list
// the parent row first, then its children.
export async function archiveRecord(entity, recordId, rows, deletedBy) {
  await ensureDeletedRecords();
  // Drop any stale archive for this id so the newest delete wins.
  await sql`DELETE FROM deleted_records WHERE record_id = ${recordId}`;
  await sql`
    INSERT INTO deleted_records (id, entity, record_id, payload, deleted_by)
    VALUES (${makeId('del')}, ${entity}, ${recordId}, ${JSON.stringify({ rows })}::jsonb, ${deletedBy || null})`;
}

// Re-insert the archived rows for a record id (same ids → redo-safe). Returns
// true if something was restored. Idempotent: ON CONFLICT DO NOTHING.
export async function restoreRecord(recordId) {
  await ensureDeletedRecords();
  const [archive] = await sql`SELECT payload FROM deleted_records WHERE record_id = ${recordId} ORDER BY deleted_at DESC LIMIT 1`;
  if (!archive) return false;
  const rows = archive.payload?.rows || [];
  for (const { table, row } of rows) {
    if (!RESTORABLE_TABLES.has(table) || !row) continue;
    const json = JSON.stringify(row);
    // json_populate_record rebuilds a full typed row from the archived JSON.
    if (table === 'tasks') {
      await sql`INSERT INTO tasks SELECT * FROM json_populate_record(NULL::tasks, ${json}::json) ON CONFLICT (id) DO NOTHING`;
    } else if (table === 'task_assignees') {
      await sql`INSERT INTO task_assignees SELECT * FROM json_populate_record(NULL::task_assignees, ${json}::json) ON CONFLICT DO NOTHING`;
    } else if (table === 'manual_pending_payments') {
      await sql`INSERT INTO manual_pending_payments SELECT * FROM json_populate_record(NULL::manual_pending_payments, ${json}::json) ON CONFLICT (id) DO NOTHING`;
    } else if (table === 'cashflow_costs') {
      await sql`INSERT INTO cashflow_costs SELECT * FROM json_populate_record(NULL::cashflow_costs, ${json}::json) ON CONFLICT (id) DO NOTHING`;
    } else if (table === 'project_videos') {
      await sql`INSERT INTO project_videos SELECT * FROM json_populate_record(NULL::project_videos, ${json}::json) ON CONFLICT (id) DO NOTHING`;
    } else if (table === 'video_milestones') {
      await sql`INSERT INTO video_milestones SELECT * FROM json_populate_record(NULL::video_milestones, ${json}::json) ON CONFLICT (id) DO NOTHING`;
    } else if (table === 'video_milestone_assets') {
      await sql`INSERT INTO video_milestone_assets SELECT * FROM json_populate_record(NULL::video_milestone_assets, ${json}::json) ON CONFLICT (id) DO NOTHING`;
    } else if (table === 'video_scripts') {
      await sql`INSERT INTO video_scripts SELECT * FROM json_populate_record(NULL::video_scripts, ${json}::json) ON CONFLICT (id) DO NOTHING`;
    } else if (table === 'video_assignees') {
      await sql`INSERT INTO video_assignees SELECT * FROM json_populate_record(NULL::video_assignees, ${json}::json) ON CONFLICT DO NOTHING`;
    }
  }
  await sql`DELETE FROM deleted_records WHERE record_id = ${recordId}`;
  return true;
}

// POST /api/crm/restore/<recordId> — bring back a recently deleted record.
// Authorisation mirrors the original delete: the caller must hold the entity's
// manage permission (RESTORE_PERMISSION), or — for ownership-gated entities —
// be the user who deleted the record. Without this gate any authenticated
// account could resurrect financial / production / task rows it never owned.
export async function restoreRoute(req, res, id, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!id) return res.status(400).json({ error: 'record id required' });
  await ensureDeletedRecords();

  const [meta] = await sql`
    SELECT entity, deleted_by FROM deleted_records
    WHERE record_id = ${id} ORDER BY deleted_at DESC LIMIT 1`;
  // Nothing archived under this id — idempotent no-op (don't reveal anything).
  if (!meta) return res.status(200).json({ ok: false, restored: false });

  const slug = RESTORE_PERMISSION[meta.entity];
  if (!slug) return res.status(403).json({ error: 'This record type cannot be restored' });

  const role = await getRole(user?.role);
  const isDeleter = !!(meta.deleted_by && user?.email
    && meta.deleted_by.toLowerCase() === user.email.toLowerCase());
  const allowed = hasPermission(role, slug) || (OWNER_RESTORABLE.has(meta.entity) && isDeleter);
  if (!allowed) {
    return res.status(403).json({ error: 'You do not have permission to restore this record' });
  }

  const ok = await restoreRecord(id);
  return res.status(200).json({ ok, restored: ok });
}
