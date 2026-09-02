-- Pipeline archive: which finished deals are off the Sales Pipeline board.
--
-- Paid and Lost never empty themselves, so every deal we have ever won or lost
-- piles up in them. Deals that have sat in one of those stages for over a month
-- with no money outstanding drop off the board automatically (no state needed —
-- it is derived from stage_changed_at). These columns record the two manual
-- overrides on top of that rule:
--
--   pipeline_archived_at  — cleared off the board by hand, whatever its age
--   pipeline_restored_at  — pulled back onto the board and kept there, even
--                           though the age rule would otherwise clear it
--
-- The two are mutually exclusive: setting either clears the other. Both are
-- display-only — the deal itself, its finance, files and reporting are
-- untouched, which is the whole point of an archive rather than a delete.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS pipeline_archived_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS pipeline_archived_by TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS pipeline_restored_at TIMESTAMPTZ;
