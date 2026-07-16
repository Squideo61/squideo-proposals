-- Admin-editable default proposal. When set, every new proposal is created from
-- this base instead of the hardcoded DEFAULT_PROPOSAL in src/defaults.js. Edited
-- via Admin → Default proposal (requires the settings.manage permission).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS default_proposal JSONB;
