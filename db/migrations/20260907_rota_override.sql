-- Per-person override for "produces scheduled content" (i.e. gets a rota column
-- and is assignable on the production schedule).
--
-- Until now this was decided purely by role — copywriters were off the rota as
-- a whole role — which left no way to put a copywriter learning production on
-- the schedule without changing their account type. NULL keeps the role default;
-- TRUE / FALSE overrides it for that person.
ALTER TABLE leave_allowances ADD COLUMN IF NOT EXISTS on_rota BOOLEAN;
