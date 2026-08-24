-- Email marketing — Marketing → Email. Compose one email, send it to a mailing
-- list (everyone / customers / non-customers), then watch opens and clicks.
--
-- Deliberately built ON TOP of the existing tracking tables rather than beside
-- them: every recipient gets an ordinary `email_tracking` row, so opens and
-- clicks land in `email_tracking_events` through the same public /api/track
-- endpoints the CRM composer already uses. Nothing new listens on the internet,
-- and the per-recipient geo/UA detail comes for free.
--
-- These objects are also self-healed at runtime (ensureCampaignTables in
-- api/_lib/crm/campaigns.js) because migrations are applied by hand in Neon.

CREATE TABLE IF NOT EXISTS email_campaigns (
  id            TEXT        PRIMARY KEY,
  name          TEXT        NOT NULL,
  audience      TEXT        NOT NULL DEFAULT 'everyone',  -- everyone | customers | non_customers
  subject       TEXT        NOT NULL DEFAULT '',
  preheader     TEXT,                                     -- inbox preview line
  body_html     TEXT        NOT NULL DEFAULT '',
  reply_to      TEXT,
  status        TEXT        NOT NULL DEFAULT 'draft',     -- draft|scheduled|sending|sent|paused|cancelled
  scheduled_at  TIMESTAMPTZ,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_campaigns_status_idx ON email_campaigns (status);

-- The audience SNAPSHOT. Rows are written when the campaign is sent (not when
-- it's drafted), so a list that grows mid-send can't quietly change who the
-- campaign went to — and a re-run can never double-send, because the unique
-- index below is the queue's idempotency key.
CREATE TABLE IF NOT EXISTS email_campaign_recipients (
  id           BIGSERIAL   PRIMARY KEY,
  campaign_id  TEXT        NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
  email        TEXT        NOT NULL,
  name         TEXT,
  company_name TEXT,
  contact_id   TEXT,
  company_id   TEXT,
  is_customer  BOOLEAN     NOT NULL DEFAULT FALSE,
  status       TEXT        NOT NULL DEFAULT 'queued',     -- queued|sent|failed|skipped
  tracking_id  BIGINT      REFERENCES email_tracking(id) ON DELETE SET NULL,
  provider_id  TEXT,                                      -- Resend message id
  error        TEXT,
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_campaign_recipients_unique_idx
  ON email_campaign_recipients (campaign_id, email);
CREATE INDEX IF NOT EXISTS email_campaign_recipients_queue_idx
  ON email_campaign_recipients (campaign_id, status);
CREATE INDEX IF NOT EXISTS email_campaign_recipients_tracking_idx
  ON email_campaign_recipients (tracking_id);
