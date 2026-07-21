-- Human-readable reference numbers for deals (and their videos).
--
-- A deal's reference is YYMM-NNN — the month it was formed plus a sequence
-- within that month, e.g. 2607-014 = the 14th deal formed in July 2026. It
-- doubles as the project number once the deal is in production, replacing the
-- number previously derived from the deal's earliest proposal (so every deal
-- has a number from day one, not just those with a proposal raised).
--
-- Each video carries a per-deal ordinal, rendered as <deal reference>-NN:
-- 2607-014-01, 2607-014-02, … The ordinal is stored rather than derived from
-- sort_order so reordering or deleting a video never renumbers the others.
--
-- Apply in the Neon console. The API self-heals both columns (and the
-- backfill) via ensureDealReference() / ensureVideoNumber(), so this migration
-- is idempotent and safe to run late.

ALTER TABLE deals ADD COLUMN IF NOT EXISTS reference TEXT;

-- Backfill in creation order, numbered within each calendar month.
WITH numbered AS (
  SELECT id,
         to_char(created_at, 'YYMM') AS ym,
         row_number() OVER (PARTITION BY to_char(created_at, 'YYMM')
                                ORDER BY created_at, id) AS seq
    FROM deals
   WHERE reference IS NULL
)
UPDATE deals d
   SET reference = n.ym || '-' || lpad(n.seq::text, 3, '0')
  FROM numbered n
 WHERE d.id = n.id;

-- One deal per reference. Also the lookup index for reference search.
CREATE UNIQUE INDEX IF NOT EXISTS deals_reference_idx ON deals (reference);

ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS video_number INTEGER;

WITH numbered AS (
  SELECT id,
         row_number() OVER (PARTITION BY deal_id
                                ORDER BY sort_order, created_at, id) AS num
    FROM project_videos
   WHERE video_number IS NULL
)
UPDATE project_videos pv
   SET video_number = n.num
  FROM numbered n
 WHERE pv.id = n.id;

CREATE UNIQUE INDEX IF NOT EXISTS project_videos_number_idx
    ON project_videos (deal_id, video_number);
