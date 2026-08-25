-- Ties a queued nudge email to its open/click tracking row.
--
-- The brief-builder and video-guide sequences went out untracked, so Marketing
-- could say how many nudges were sent but not whether a single one was read.
-- The send path now mints an email_tracking row (source 'nudge') and stamps its
-- id here, which is what Marketing → Brief builder joins against to report an
-- open rate per step.
--
-- Nullable by design: every nudge sent before this existed keeps a NULL, and
-- the reports count those as "sent, not measured" rather than as unopened.
-- Mirrored by the self-heal in api/_lib/course/emails.js.

ALTER TABLE course_emails ADD COLUMN IF NOT EXISTS tracking_id BIGINT;

-- The report walks from a nudge to its tracking row; without this the join is a
-- sequential scan of the whole queue once the sequences have been running a
-- while.
CREATE INDEX IF NOT EXISTS course_emails_tracking_idx
  ON course_emails (tracking_id) WHERE tracking_id IS NOT NULL;
