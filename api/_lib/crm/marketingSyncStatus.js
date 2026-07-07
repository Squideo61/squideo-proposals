// Persistent "last sync" status per Marketing data source (ads / gsc / ga4), so a
// broken sync is visible in-product instead of silently leaving a tab empty.
// Written by every sync run — the manual "Sync now" button AND the daily crons —
// and read by the Marketing Traffic/Search tabs + the Settings panel.
import sql from '../db.js';

let ensured = null;
export function ensureSyncStatus() {
  if (ensured) return ensured;
  ensured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS marketing_sync_status (
        source     TEXT PRIMARY KEY,
        ok         BOOLEAN NOT NULL DEFAULT false,
        message    TEXT,
        row_count  INTEGER,
        ran_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
  })().catch((err) => { ensured = null; throw err; });
  return ensured;
}

// Normalise a run*Sync outcome (its result object, or a thrown Error) into a
// status row and upsert it. Never throws — status tracking must not break a sync.
// A not-configured/skipped run is ignored so it can't clobber a real prior status.
export async function recordSyncStatus(source, outcome) {
  try {
    if (outcome?.skipped) return;
    await ensureSyncStatus();
    let ok, message, rowCount = null;
    if (outcome instanceof Error) {
      ok = false; message = outcome.message || 'failed';
    } else if (outcome?.ok) {
      ok = true; message = 'ok';
      rowCount = outcome.rows ?? outcome.queryRows ?? outcome.keywordRows ?? outcome.totalRows ?? null;
    } else {
      ok = false; message = outcome?.error || 'failed';
    }
    await sql`
      INSERT INTO marketing_sync_status (source, ok, message, row_count, ran_at)
      VALUES (${source}, ${ok}, ${message}, ${rowCount == null ? null : Math.round(Number(rowCount))}, NOW())
      ON CONFLICT (source) DO UPDATE SET
        ok = EXCLUDED.ok, message = EXCLUDED.message,
        row_count = EXCLUDED.row_count, ran_at = NOW()`;
  } catch (err) {
    console.error('[recordSyncStatus]', source, err?.message);
  }
}

const shape = (r) => ({ ok: !!r.ok, message: r.message || null, rowCount: r.row_count ?? null, ranAt: r.ran_at });

// getSyncStatus('ga4') → one status (or null); getSyncStatus() → { ga4, gsc, ads }.
export async function getSyncStatus(source) {
  try {
    await ensureSyncStatus();
    if (source) {
      const [row] = await sql`SELECT source, ok, message, row_count, ran_at FROM marketing_sync_status WHERE source = ${source}`;
      return row ? shape(row) : null;
    }
    const rows = await sql`SELECT source, ok, message, row_count, ran_at FROM marketing_sync_status`;
    const out = {};
    for (const r of rows) out[r.source] = shape(r);
    return out;
  } catch (err) {
    console.error('[getSyncStatus]', err?.message);
    return source ? null : {};
  }
}
