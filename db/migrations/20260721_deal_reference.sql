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

-- Backfill in creation order, numbered within each calendar month. Continues
-- from the highest sequence already issued that month rather than restarting at
-- 1 — deals arrive with a NULL reference from other insert paths (portal
-- onboarding, project create, quote-form leads), so this runs against a live
-- table and must never re-issue a reference another deal already holds.
WITH issued AS (
  SELECT substring(reference from 1 for 4) AS ym,
         MAX(substring(reference from 6)::int) AS max_seq
    FROM deals
   WHERE reference ~ '^\d{4}-\d+$'
   GROUP BY substring(reference from 1 for 4)
),
numbered AS (
  SELECT d.id,
         to_char(COALESCE(d.created_at, NOW()), 'YYMM') AS ym,
         COALESCE(i.max_seq, 0)
           + row_number() OVER (PARTITION BY to_char(COALESCE(d.created_at, NOW()), 'YYMM')
                                    ORDER BY d.created_at, d.id) AS seq
    FROM deals d
    LEFT JOIN issued i ON i.ym = to_char(COALESCE(d.created_at, NOW()), 'YYMM')
   WHERE d.reference IS NULL
)
UPDATE deals d
   -- lpad TRUNCATES when the value is longer than the width, so a month past
   -- 999 must bypass it or 1000 would become '100' and collide.
   SET reference = n.ym || '-' ||
         CASE WHEN n.seq < 1000 THEN lpad(n.seq::text, 3, '0') ELSE n.seq::text END
  FROM numbered n
 WHERE d.id = n.id;

-- One deal per reference. Also the lookup index for reference search.
CREATE UNIQUE INDEX IF NOT EXISTS deals_reference_idx ON deals (reference);

ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS video_number INTEGER;

-- Same rule as above: continue from the highest ordinal already issued for the
-- deal, so a video created after an earlier partial run can't take a number a
-- sibling already has.
WITH issued AS (
  SELECT deal_id, MAX(video_number) AS max_num
    FROM project_videos WHERE video_number IS NOT NULL GROUP BY deal_id
),
numbered AS (
  SELECT pv.id,
         COALESCE(i.max_num, 0)
           + row_number() OVER (PARTITION BY pv.deal_id
                                    ORDER BY pv.sort_order, pv.created_at, pv.id) AS num
    FROM project_videos pv
    LEFT JOIN issued i ON i.deal_id = pv.deal_id
   WHERE pv.video_number IS NULL
)
UPDATE project_videos pv
   SET video_number = n.num
  FROM numbered n
 WHERE pv.id = n.id;

CREATE UNIQUE INDEX IF NOT EXISTS project_videos_number_idx
    ON project_videos (deal_id, video_number);
