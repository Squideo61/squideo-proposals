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

// Tables we allow restoring into. The table name can't be parameterised in the
// json_populate_record call, so it must come from this fixed allowlist.
const RESTORABLE_TABLES = new Set(['tasks', 'task_assignees', 'manual_pending_payments', 'cashflow_costs']);

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
    }
  }
  await sql`DELETE FROM deleted_records WHERE record_id = ${recordId}`;
  return true;
}

// POST /api/crm/restore/<recordId> — bring back a recently deleted record.
export async function restoreRoute(req, res, id) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!id) return res.status(400).json({ error: 'record id required' });
  const ok = await restoreRecord(id);
  return res.status(200).json({ ok, restored: ok });
}
