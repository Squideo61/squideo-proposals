-- Indexes for the Marketing → Email screens.
--
-- The audience, the campaign report, the bounce-by-year breakdown and the
-- per-provider table all match people up by LOWER(TRIM(email)) — addresses
-- arrive with stray case and whitespace from three different sources, so they
-- have to be normalised to compare.
--
-- Postgres cannot use a plain index on `email` for an expression like
-- LOWER(TRIM(email)); it needs an index on that exact expression. Without one,
-- every LATERAL lookup is a full table scan, and the report runs several of
-- them per recipient. On a few thousand recipients against a few thousand quote
-- requests that is millions of comparisons per page load, which is why these
-- screens crawl.
--
-- The expressions below must stay character-for-character identical to the ones
-- in api/_lib/crm/campaigns.js, or the planner silently ignores them.

CREATE INDEX IF NOT EXISTS quote_requests_email_lower_idx
  ON quote_requests (LOWER(TRIM(email)));

CREATE INDEX IF NOT EXISTS course_signups_email_lower_idx
  ON course_signups (LOWER(TRIM(email)));

CREATE INDEX IF NOT EXISTS contacts_email_lower_idx
  ON contacts (LOWER(TRIM(email)));

-- Recipients are looked up by address (suppression join, bounce matching) and
-- searched by address.
CREATE INDEX IF NOT EXISTS email_campaign_recipients_email_idx
  ON email_campaign_recipients (email);

-- Every open/click aggregate filters by kind within a tracking row.
CREATE INDEX IF NOT EXISTS email_tracking_events_tracking_kind_idx
  ON email_tracking_events (tracking_id, kind);
