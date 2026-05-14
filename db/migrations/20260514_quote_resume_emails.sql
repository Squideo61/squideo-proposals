CREATE TABLE IF NOT EXISTS quote_request_resume_emails (
  id                 TEXT        PRIMARY KEY,
  form_session_id    TEXT        NOT NULL,
  email              TEXT        NOT NULL,
  name               TEXT,
  resume_url         TEXT        NOT NULL,
  kind               TEXT        NOT NULL,
  unsubscribe_token  TEXT        NOT NULL,
  scheduled_for      TIMESTAMPTZ NOT NULL,
  sent_at            TIMESTAMPTZ,
  unsubscribed_at    TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS qr_resume_emails_due_idx
  ON quote_request_resume_emails (scheduled_for)
  WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS qr_resume_emails_session_idx
  ON quote_request_resume_emails (form_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS qr_resume_emails_token_idx
  ON quote_request_resume_emails (unsubscribe_token);
