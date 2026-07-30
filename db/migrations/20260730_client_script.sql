-- Client-facing "Script & visual direction" stage (customer portal).
--
-- To the client this is ONE step: send us the script and any visual direction
-- for the project. It often arrives long before the deal closes, so staff can
-- tick "we already have it" instead of the portal asking again — and the client
-- can still upload further versions at any time, which alerts the team.
--
-- Idempotent. Also self-healed at runtime by ensurePortalTables()
-- (api/_lib/portal/db.js), so a manual Neon apply is optional.

-- NULL = still waiting | 'received' = we have their script (staff-ticked or
-- client-uploaded) | 'squideo' = they've asked us to write it.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS script_status    TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS script_status_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS script_status_by TEXT;

-- Portal deal uploads are filed by what they are: 'script' | 'visual_direction'
-- (the two halves of the one client-facing stage), or NULL for a general
-- project document.
ALTER TABLE deal_files ADD COLUMN IF NOT EXISTS category TEXT;
CREATE INDEX IF NOT EXISTS deal_files_category_idx ON deal_files(deal_id, category);
