-- Email open/click tracking (Streak-style). A tracking row is created per
-- outgoing email we can instrument (CRM composer now; the browser extension
-- later). The HTML carries an invisible 1x1 pixel hitting /api/track/open and
-- has its links rewritten through /api/track/click, both keyed by `token`.
--
-- Opens/clicks land in email_tracking_events with the viewer's IP + geo (from
-- Vercel's edge headers — no external service). Rewritten links are stored in
-- email_tracking_links so the click endpoint never trusts a URL from the query
-- string (no open-redirect surface).

CREATE TABLE IF NOT EXISTS email_tracking (
  id               BIGSERIAL PRIMARY KEY,
  token            TEXT UNIQUE NOT NULL,
  user_email       TEXT NOT NULL,
  gmail_message_id TEXT,
  gmail_thread_id  TEXT,
  subject          TEXT,
  recipients       TEXT[] NOT NULL DEFAULT '{}',
  source           TEXT NOT NULL DEFAULT 'crm',   -- 'crm' | 'extension'
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_tracking_thread_idx ON email_tracking (gmail_thread_id);
CREATE INDEX IF NOT EXISTS email_tracking_user_idx   ON email_tracking (user_email);

CREATE TABLE IF NOT EXISTS email_tracking_links (
  id          BIGSERIAL PRIMARY KEY,
  tracking_id BIGINT NOT NULL REFERENCES email_tracking(id) ON DELETE CASCADE,
  idx         INT NOT NULL,
  url         TEXT NOT NULL,
  UNIQUE (tracking_id, idx)
);

CREATE TABLE IF NOT EXISTS email_tracking_events (
  id          BIGSERIAL PRIMARY KEY,
  tracking_id BIGINT NOT NULL REFERENCES email_tracking(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                       -- 'open' | 'click'
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address  TEXT,
  country     TEXT,
  region      TEXT,
  city        TEXT,
  user_agent  TEXT,
  link_url    TEXT                                 -- destination for 'click' events
);
CREATE INDEX IF NOT EXISTS email_tracking_events_tracking_idx ON email_tracking_events (tracking_id);
