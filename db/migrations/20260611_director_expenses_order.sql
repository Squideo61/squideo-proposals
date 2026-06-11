-- Manual drag-ordering of director expenses within each director's list.
-- Also self-healed in ensureDirectorExpenses() (api/_lib/crm/stats.js).

ALTER TABLE director_expenses ADD COLUMN IF NOT EXISTS sort_order INT;
