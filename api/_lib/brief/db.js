// Runtime self-heal for client_briefs, mirroring
// db/migrations/20260805_client_briefs.sql.
//
// Like every ensure*() here it must RESOLVE on failure, never reject — a
// permissions error on a CREATE TABLE IF NOT EXISTS once took the whole CRM
// down with a 500, and the fix is that these are best-effort by construction.

import sql from '../db.js';

let ensured = null;
export function ensureClientBriefs() {
  if (ensured) return ensured;
  ensured = (async () => {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS client_briefs (
          id               TEXT        PRIMARY KEY,
          portal_user_id   TEXT        NOT NULL,
          company_id       TEXT,
          deal_id          TEXT,
          answers          JSONB       NOT NULL DEFAULT '{}'::jsonb,
          completed_at     TIMESTAMPTZ,
          submitted_at     TIMESTAMPTZ,
          quote_request_id TEXT,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS client_briefs_open_idx
                  ON client_briefs (portal_user_id) WHERE submitted_at IS NULL`;
      await sql`CREATE INDEX IF NOT EXISTS client_briefs_company_idx ON client_briefs (company_id)`;
      await sql`CREATE INDEX IF NOT EXISTS client_briefs_updated_idx ON client_briefs (updated_at DESC)`;
    } catch (err) {
      console.warn('[clientBriefs] ensure failed', err.message);
    }
  })();
  return ensured;
}
