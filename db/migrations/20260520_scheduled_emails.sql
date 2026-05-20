-- Scheduled emails: composer-queued sends that the scheduled-emails cron
-- dispatches once scheduled_for passes. payload holds the full send payload
-- (to/cc/bcc/subject/html/text/extraDealIds/attachments) so the cron can call
-- performGmailSend without any other context.
CREATE TABLE IF NOT EXISTS scheduled_emails (
  id            TEXT        PRIMARY KEY,
  user_email    TEXT        NOT NULL,
  deal_id       TEXT,
  payload       JSONB       NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'pending',  -- pending | sent | failed | cancelled
  sent_at       TIMESTAMPTZ,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS scheduled_emails_due_idx
  ON scheduled_emails (scheduled_for)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS scheduled_emails_deal_idx
  ON scheduled_emails (deal_id)
  WHERE status = 'pending';
