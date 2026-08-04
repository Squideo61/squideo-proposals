-- Global email suppression + the crash-course nudge schedule.
--
-- The course nudges are the first genuine MARKETING email the product sends.
-- Everything before this was transactional (invoices, resets, review requests)
-- or the abandoned-quote drip, which carried its own per-session unsubscribe
-- flag. Per-campaign flags don't compose: unsubscribing from the quote drip
-- told us nothing about whether we could send a course nudge. Under UK PECR an
-- opt-out has to be honoured across everything, so it lives in one table and is
-- enforced inside sendMail() itself.
--
-- Self-healed at runtime by ensureSuppressionTable() (api/_lib/emailSuppression.js)
-- and ensureCourseEmails() (api/_lib/course/emails.js).

CREATE TABLE IF NOT EXISTS email_suppressions (
  email      TEXT        PRIMARY KEY,        -- always stored lower-cased
  -- 'marketing' = stop selling to me (invoices etc. still send).
  -- 'all'       = hard bounce or spam complaint; nothing sends, ever.
  scope      TEXT        NOT NULL DEFAULT 'marketing',
  reason     TEXT        NOT NULL,           -- unsubscribe | bounce | complaint | manual
  source     TEXT,                           -- course | quote-resume | admin
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Honour the unsubscribes we already hold. Anyone who opted out of the
-- abandoned-quote drip has opted out of marketing, full stop — sending them a
-- course nudge because it's "a different campaign" is exactly the behaviour
-- the regulation exists to stop.
INSERT INTO email_suppressions (email, scope, reason, source)
SELECT DISTINCT LOWER(email), 'marketing', 'unsubscribe', 'quote-resume'
  FROM quote_request_resume_emails
 WHERE unsubscribed_at IS NOT NULL
   AND email IS NOT NULL AND TRIM(email) <> ''
ON CONFLICT (email) DO NOTHING;

-- The nudge schedule. Same shape as quote_request_resume_emails, plus
-- cancelled_at so the series can be stopped early when someone finishes the
-- course or gets in touch.
CREATE TABLE IF NOT EXISTS course_emails (
  id               TEXT        PRIMARY KEY,
  course_signup_id TEXT        NOT NULL REFERENCES course_signups(id) ON DELETE CASCADE,
  email            TEXT        NOT NULL,
  kind             TEXT        NOT NULL,     -- welcome | nudge_1..3 | offer_1..2
  scheduled_for    TIMESTAMPTZ NOT NULL,
  sent_at          TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial index: the cron only ever asks for rows that are due and still live.
CREATE INDEX IF NOT EXISTS course_emails_due_idx
  ON course_emails (scheduled_for)
  WHERE sent_at IS NULL AND cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS course_emails_signup_idx ON course_emails (course_signup_id);

-- One row per (signup, step): re-running the scheduler must not double-send.
CREATE UNIQUE INDEX IF NOT EXISTS course_emails_step_idx
  ON course_emails (course_signup_id, kind);
