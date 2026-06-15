-- Google Ads spend, pulled daily by the ad-spend-sync cron (GAQL via REST) and
-- joined to leads on campaign_id (and keyword) to produce cost-per-lead / ROAS.
-- Grain: one row per day x campaign x ad group x criterion (keyword). Campaign-
-- level rows (Performance Max / non-keyword spend) use empty-string ad_group_id
-- / criterion_id so they still reconcile against the same primary key.
--
-- Mirrored by ensureAdSpend() (api/_lib/crm/googleAds.js) which self-heals this
-- table on first sync.

CREATE TABLE IF NOT EXISTS ad_spend_daily (
  day           DATE        NOT NULL,
  customer_id   TEXT        NOT NULL,
  campaign_id   TEXT        NOT NULL,
  campaign_name TEXT,
  ad_group_id   TEXT        NOT NULL DEFAULT '',
  ad_group_name TEXT,
  criterion_id  TEXT        NOT NULL DEFAULT '',
  keyword_text  TEXT,
  cost_micros   BIGINT      NOT NULL DEFAULT 0,
  clicks        BIGINT      NOT NULL DEFAULT 0,
  impressions   BIGINT      NOT NULL DEFAULT 0,
  conversions   NUMERIC     NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, customer_id, campaign_id, ad_group_id, criterion_id)
);

CREATE INDEX IF NOT EXISTS ad_spend_daily_campaign_idx ON ad_spend_daily(campaign_id);
CREATE INDEX IF NOT EXISTS ad_spend_daily_day_idx      ON ad_spend_daily(day);
