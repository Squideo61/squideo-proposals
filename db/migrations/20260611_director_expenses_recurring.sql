-- Recurring director expenses: a row marked recurring repeats every month from
-- its `month` (start) onward, until `effective_to` (a 'YYYY-MM', if ever set).
-- One-offs keep recurring = false and count only in their own month.
-- Also self-healed in ensureDirectorExpenses() (api/_lib/crm/stats.js).

ALTER TABLE director_expenses ADD COLUMN IF NOT EXISTS recurring BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE director_expenses ADD COLUMN IF NOT EXISTS effective_to TEXT;
