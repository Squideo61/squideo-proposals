-- Multiple producers / team members per video and per project (deal).
--
-- Mirrors the task_assignees pattern: a join table holds the full set, while the
-- legacy single producer_email column is kept populated with the first assignee
-- for back-compat (board grouping, older reads). Idempotent; also self-healed at
-- runtime by ensureProductionSchema() in api/_lib/production.js.

CREATE TABLE IF NOT EXISTS video_assignees (
  video_id    TEXT        NOT NULL REFERENCES project_videos(id) ON DELETE CASCADE,
  user_email  TEXT        NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (video_id, user_email)
);

CREATE TABLE IF NOT EXISTS deal_assignees (
  deal_id     TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_email  TEXT        NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (deal_id, user_email)
);

-- One-time backfill from the existing single producer: only for rows that have
-- no assignees yet, so it never re-adds a producer the team has since removed.
INSERT INTO video_assignees (video_id, user_email)
  SELECT pv.id, pv.producer_email FROM project_videos pv
   WHERE pv.producer_email IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM video_assignees va WHERE va.video_id = pv.id)
  ON CONFLICT DO NOTHING;

INSERT INTO deal_assignees (deal_id, user_email)
  SELECT d.id, d.producer_email FROM deals d
   WHERE d.producer_email IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM deal_assignees da WHERE da.deal_id = d.id)
  ON CONFLICT DO NOTHING;
