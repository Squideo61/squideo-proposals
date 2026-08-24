-- Two things a first big send needs: the ability to leave individuals out, and
-- a speed limit.

-- People deliberately left off ONE campaign. Not the same as a suppression:
-- that is "never sell to me again", global and the recipient's own decision.
-- This is the sender's, for this send only — the client you're mid-argument
-- with, the competitor who signed up, the person you already emailed today.
CREATE TABLE IF NOT EXISTS email_campaign_exclusions (
  campaign_id TEXT        NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
  email       TEXT        NOT NULL,
  reason      TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, email)
);

-- Send throttle. A domain with no marketing history that suddenly posts four
-- thousand emails looks exactly like a compromised account, and the mailbox
-- providers treat it as one. These caps let a big list go out over days
-- instead, which is what warming up actually means.
--
-- NULL = no limit (the old behaviour, ~300/minute).
ALTER TABLE email_campaigns
  ADD COLUMN IF NOT EXISTS hourly_cap INTEGER,
  ADD COLUMN IF NOT EXISTS daily_cap  INTEGER;

-- Bounces and complaints need to be attributable back to the campaign that
-- caused them, and a recipient row needs somewhere to say so.
ALTER TABLE email_campaign_recipients
  ADD COLUMN IF NOT EXISTS bounced_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bounce_kind  TEXT;      -- hard | soft | complaint

CREATE INDEX IF NOT EXISTS email_campaign_recipients_provider_idx
  ON email_campaign_recipients (provider_id) WHERE provider_id IS NOT NULL;
