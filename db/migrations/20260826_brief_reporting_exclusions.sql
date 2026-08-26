-- Let staff drop a brief out of the Marketing → Brief builder report.
--
-- The report measures a lead magnet, so it should only count strangers. Two
-- kinds of noise are detected automatically and need no flag: our own accounts
-- (api/_lib/internalAccounts.js — the @squideo domains plus portal_users
-- .internal) and the seeded demo project (api/_lib/crm/demoScope.js).
--
-- What neither catches is a test someone ran under a personal address, or a
-- throwaway "test" brief typed to see what the form does. Nothing about those
-- rows distinguishes them from a real lead, so it takes a human saying so —
-- which is what this column records.
--
-- Nullable and unset by default: a brief counts unless somebody says otherwise.
-- Excluding is reversible and non-destructive; the row is untouched and still
-- readable, it just stops skewing conversion rates.
--
-- Mirrored by the self-heal in ensureClientBriefs() (api/_lib/brief/db.js), so
-- the report works on an instance where this migration hasn't been run.

ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS excluded_at TIMESTAMPTZ;
ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS excluded_by TEXT;

-- The report reads the whole period and filters in JS, so this is only for the
-- "what have we scrubbed?" direction, which is a small minority of rows.
CREATE INDEX IF NOT EXISTS client_briefs_excluded_idx
  ON client_briefs (excluded_at) WHERE excluded_at IS NOT NULL;
