-- Director expenses (Finance → Performance → Directors): a "Scanned" status tag
-- for expenses whose receipt was entered straight into Xero, so there's no need
-- to attach one here. Just a flag, like `vattable`. Idempotent; also self-healed
-- in ensureDirectorExpenses() in stats.js.

ALTER TABLE director_expenses ADD COLUMN IF NOT EXISTS scanned BOOLEAN NOT NULL DEFAULT false;
