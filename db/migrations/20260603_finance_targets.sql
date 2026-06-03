-- Editable monthly revenue targets for the Business → Performance graph.
-- JSONB array of { key, label, amount, color }. NULL → app falls back to the
-- seeded defaults in api/settings.js.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS finance_targets JSONB;
