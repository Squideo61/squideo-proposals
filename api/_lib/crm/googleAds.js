// Google Ads sync — pulls daily spend/clicks/impressions/conversions per
// campaign + keyword via the Google Ads REST API (GAQL), and upserts them into
// ad_spend_daily for the Marketing reports to join against (on campaign id /
// keyword). REST + GAQL deliberately, to avoid the gRPC/protobuf cold-start cost
// of the google-ads-api npm package on Vercel serverless.
//
// Everything here is gated behind adsConfigured(): until all six env vars are
// present (the developer token in particular can take days to be approved),
// the cron no-ops and the reports simply render spend/CPL/ROAS as "—". Revenue
// attribution needs none of this.
import sql from '../db.js';

// Google Ads API versions are sunset ~12 months after release, which 404s the
// request path. Default to a current version; overridable via env var so a
// future sunset can be handled without a code change.
const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v24';
const ENV = [
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_CUSTOMER_ID',
  'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
];

export function adsConfigured() {
  return ENV.every((k) => !!process.env[k]);
}

const digits = (s) => String(s || '').replace(/[^0-9]/g, '');

// Self-heal ad_spend_daily so the first sync can't hit a missing table even if
// 20260615_ad_spend.sql wasn't run. Memoised per cold start.
let ensured = null;
export function ensureAdSpend() {
  if (ensured) return ensured;
  ensured = (async () => {
    await sql`
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
      )`;
    await sql`CREATE INDEX IF NOT EXISTS ad_spend_daily_campaign_idx ON ad_spend_daily(campaign_id)`;
    await sql`CREATE INDEX IF NOT EXISTS ad_spend_daily_day_idx      ON ad_spend_daily(day)`;
  })().catch((err) => { ensured = null; throw err; });
  return ensured;
}

// Short-lived OAuth access token from the long-lived refresh token. Cached in
// module scope until ~1 min before expiry. Mirrors the Gmail refresh flow.
let tokenCache = { value: null, expiresAt: 0 };
async function getAccessToken() {
  if (tokenCache.value && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.value;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.access_token) {
    throw new Error('Google Ads OAuth failed: ' + (json.error_description || json.error || r.status));
  }
  tokenCache = {
    value: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  };
  return tokenCache.value;
}

// Run a GAQL query against the configured customer. Uses searchStream, which
// returns an array of result batches; we flatten them.
async function runGaql(query) {
  const token = await getAccessToken();
  const customerId = digits(process.env.GOOGLE_ADS_CUSTOMER_ID);
  const r = await fetch(
    `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:searchStream`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        'login-customer-id': digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    }
  );
  const json = await r.json().catch(() => null);
  if (!r.ok) {
    const detail = Array.isArray(json) ? json[0]?.error?.message : json?.error?.message;
    throw new Error('Google Ads query failed (' + r.status + '): ' + (detail || 'unknown'));
  }
  const batches = Array.isArray(json) ? json : [json];
  const out = [];
  for (const b of batches) for (const row of (b?.results || [])) out.push(row);
  return out;
}

function upsertRow(customerId, r, isCampaignLevel) {
  const day = r.segments?.date;
  if (!day) return null;
  const campaignId = String(r.campaign?.id ?? '');
  const adGroupId = isCampaignLevel ? '' : String(r.adGroup?.id ?? '');
  const criterionId = isCampaignLevel ? '' : String(r.adGroupCriterion?.criterionId ?? '');
  const m = r.metrics || {};
  return sql`
    INSERT INTO ad_spend_daily (
      day, customer_id, campaign_id, campaign_name, ad_group_id, ad_group_name,
      criterion_id, keyword_text, cost_micros, clicks, impressions, conversions, updated_at
    ) VALUES (
      ${day}, ${customerId}, ${campaignId}, ${r.campaign?.name ?? null},
      ${adGroupId}, ${isCampaignLevel ? null : (r.adGroup?.name ?? null)},
      ${criterionId}, ${isCampaignLevel ? null : (r.adGroupCriterion?.keyword?.text ?? null)},
      ${Number(m.costMicros) || 0}, ${Number(m.clicks) || 0},
      ${Number(m.impressions) || 0}, ${Number(m.conversions) || 0}, NOW()
    )
    ON CONFLICT (day, customer_id, campaign_id, ad_group_id, criterion_id) DO UPDATE SET
      campaign_name = EXCLUDED.campaign_name,
      ad_group_name = EXCLUDED.ad_group_name,
      keyword_text  = EXCLUDED.keyword_text,
      cost_micros   = EXCLUDED.cost_micros,
      clicks        = EXCLUDED.clicks,
      impressions   = EXCLUDED.impressions,
      conversions   = EXCLUDED.conversions,
      updated_at    = NOW()
  `;
}

const KEYWORD_QUERY = `
  SELECT segments.date, campaign.id, campaign.name, ad_group.id, ad_group.name,
         ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
         metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
  FROM keyword_view
  WHERE segments.date DURING LAST_14_DAYS`;

// Campaign-level totals catch spend with no keyword dimension (Performance Max,
// Display, etc.) so the per-campaign spend still reconciles.
const CAMPAIGN_QUERY = `
  SELECT segments.date, campaign.id, campaign.name,
         metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
  FROM campaign
  WHERE segments.date DURING LAST_14_DAYS`;

// Core sync: re-pull a trailing window (so late cost/conversion adjustments
// reconcile) and upsert. Returns a small status object. Shared by the daily
// cron and the "Sync now" button in Marketing → Settings.
export async function runAdSpendSync() {
  if (!adsConfigured()) return { ok: false, skipped: 'not_configured' };
  await ensureAdSpend();
  const customerId = digits(process.env.GOOGLE_ADS_CUSTOMER_ID);
  const keywordRows = await runGaql(KEYWORD_QUERY);
  for (const r of keywordRows) { const q = upsertRow(customerId, r, false); if (q) await q; }
  const campaignRows = await runGaql(CAMPAIGN_QUERY);
  for (const r of campaignRows) { const q = upsertRow(customerId, r, true); if (q) await q; }
  return { ok: true, keywordRows: keywordRows.length, campaignRows: campaignRows.length };
}

// Cron entry: wraps runAdSpendSync and always returns 200 so a failure doesn't
// trip Vercel's cron-failure alerting (the detail is in the body + logs).
export async function cronAdSpendSync(res) {
  try {
    return res.status(200).json(await runAdSpendSync());
  } catch (err) {
    console.error('[cron ad-spend-sync]', err?.message);
    return res.status(200).json({ ok: false, error: err?.message || 'sync failed' });
  }
}
