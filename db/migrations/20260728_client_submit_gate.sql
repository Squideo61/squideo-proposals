-- Version-aware "submitted to client" gate for video + storyboard reviews.
--
-- Until now a draft became client-visible the instant it existed (the portal +
-- share-link viewer keyed off "has any version"). This adds an explicit gate so
-- staff can upload a draft, comment internally, and only THEN submit it to the
-- client. client_submitted_version is the highest version_number the client is
-- allowed to see; NULL means nothing has been sent yet. A newer draft uploaded
-- afterwards stays internal until the next submit bumps this value.

ALTER TABLE revision_videos ADD COLUMN IF NOT EXISTS client_submitted_version INT;
ALTER TABLE revision_videos ADD COLUMN IF NOT EXISTS client_submitted_at       TIMESTAMPTZ;
ALTER TABLE revision_videos ADD COLUMN IF NOT EXISTS client_submitted_by       TEXT;

ALTER TABLE storyboards     ADD COLUMN IF NOT EXISTS client_submitted_version INT;
ALTER TABLE storyboards     ADD COLUMN IF NOT EXISTS client_submitted_at       TIMESTAMPTZ;
ALTER TABLE storyboards     ADD COLUMN IF NOT EXISTS client_submitted_by       TEXT;

-- Backfill in-flight reviews so existing share links keep showing exactly what
-- they show today (treat every existing draft as already submitted). Guarded by
-- IS NULL so it never touches a review that has since been submitted for real.
UPDATE revision_videos rv
   SET client_submitted_version = sub.maxver,
       client_submitted_at      = COALESCE(rv.client_submitted_at, NOW())
  FROM (SELECT video_id, MAX(version_number) AS maxver
          FROM revision_versions GROUP BY video_id) sub
 WHERE sub.video_id = rv.id
   AND rv.client_submitted_version IS NULL;

UPDATE storyboards sb
   SET client_submitted_version = sub.maxver,
       client_submitted_at      = COALESCE(sb.client_submitted_at, NOW())
  FROM (SELECT storyboard_id, MAX(version_number) AS maxver
          FROM storyboard_versions GROUP BY storyboard_id) sub
 WHERE sub.storyboard_id = sb.id
   AND sb.client_submitted_version IS NULL;
