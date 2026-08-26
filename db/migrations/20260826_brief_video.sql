-- Which video a client brief is for.
--
-- A brief already named its deal. That was enough while a deal meant a video,
-- but a three-video project gets one brief and the team had to guess which
-- video it described — or worse, assume it covered all three.
--
-- Nullable on purpose, and most briefs will never set it. An unset brief
-- resolves to the deal's FIRST video (dealBriefVideos() in
-- api/_lib/brief/dealBriefs.js), which is right for the single-video projects
-- that are most of them, and is the sensible guess on a multi-video one. The UI
-- shows a resolved-by-default video as an assumption rather than a fact, and
-- setting it writes this column so it stops being a guess.
--
-- No foreign key: project_videos rows are archived and restored (the recycle
-- bin), and a brief must survive its video being deleted — it falls back to the
-- default rather than disappearing with it.
--
-- Mirrored by the self-heal in ensureClientBriefs() (api/_lib/brief/db.js).

ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS video_id TEXT;

-- The video page asks "is there a brief for THIS video?" on every open.
CREATE INDEX IF NOT EXISTS client_briefs_video_idx
  ON client_briefs (video_id) WHERE video_id IS NOT NULL;
