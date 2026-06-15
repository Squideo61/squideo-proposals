-- Marketing / lead-attribution: capture where each web-form lead came from.
-- First-touch attribution (gclid/UTM/ValueTrack + referrer/landing page) is
-- captured on the squideo.com marketing page by /track.js, passed into the
-- embedded quote-form iframe via postMessage, and stored alongside the lead.
-- Denormalised onto quote_requests (1-to-1, immutable) to match the existing
-- source_url / user_agent pattern. attr_campaign_id is the join key to
-- ad_spend_daily (Google Ads ValueTrack {campaignid}).
--
-- Mirrored in code by ensureLeadAttribution() (api/_lib/leadAttribution.js),
-- which self-heals these columns on cold start — so this file is the canonical
-- record but the app does not depend on it having been run.

ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_channel       TEXT;   -- paid_search|organic|social|direct|referral
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_source        TEXT;   -- utm_source
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_medium        TEXT;   -- utm_medium
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_campaign      TEXT;   -- utm_campaign (friendly name)
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_term          TEXT;   -- utm_term
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_content       TEXT;   -- utm_content
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_gclid         TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_gbraid        TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_wbraid        TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_fbclid        TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_msclkid       TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_campaign_id   TEXT;   -- ValueTrack {campaignid} -> ad_spend_daily.campaign_id
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_adgroup_id    TEXT;   -- ValueTrack {adgroupid}
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_keyword       TEXT;   -- ValueTrack {keyword}
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_matchtype     TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_network       TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_device        TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_landing_url   TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_referrer      TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_first_seen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS quote_requests_attr_channel_idx  ON quote_requests(attr_channel);
CREATE INDEX IF NOT EXISTS quote_requests_attr_campaign_idx ON quote_requests(attr_campaign_id);

-- Partials carry a subset so an abandoned-but-attributed lead still counts once
-- a reminder pulls the visitor back. First-touch wins (COALESCE on upsert).
ALTER TABLE quote_request_partials ADD COLUMN IF NOT EXISTS attr_channel     TEXT;
ALTER TABLE quote_request_partials ADD COLUMN IF NOT EXISTS attr_source      TEXT;
ALTER TABLE quote_request_partials ADD COLUMN IF NOT EXISTS attr_medium      TEXT;
ALTER TABLE quote_request_partials ADD COLUMN IF NOT EXISTS attr_campaign    TEXT;
ALTER TABLE quote_request_partials ADD COLUMN IF NOT EXISTS attr_campaign_id TEXT;
ALTER TABLE quote_request_partials ADD COLUMN IF NOT EXISTS attr_keyword     TEXT;
ALTER TABLE quote_request_partials ADD COLUMN IF NOT EXISTS attr_gclid       TEXT;
