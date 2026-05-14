-- The token is shared across all reminder rows for a single session, so the
-- previous UNIQUE constraint blocks the second INSERT. Replace with a plain
-- non-unique index.
DROP INDEX IF EXISTS qr_resume_emails_token_idx;
CREATE INDEX IF NOT EXISTS qr_resume_emails_token_idx
  ON quote_request_resume_emails (unsubscribe_token);
