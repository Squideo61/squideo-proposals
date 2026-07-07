// Google Search Console sync — pulls organic-search performance (clicks,
// impressions, CTR, average position) for squideo.com and stores it for the
// Marketing → Search report. This is data we have nowhere else: which search
// queries surface the site, and how we rank for them.
//
// Two stored grains, both upserted from a trailing window each run (GSC finalises
// data with a ~2-3 day lag, so we re-pull and reconcile):
//   • gsc_totals_daily   — one row per day (accurate headline + over-time chart)
//   • gsc_query_daily    — one row per day per query (top-queries table; we
//                          re-aggregate over the report range on read)
// Gated behind gscConfigured(): until the OAuth token + GSC_SITE_URL are present,
// the cron no-ops and the report renders empty with a "connect" hint.
import sql, { batchWrite } from '../db.js';
import { googleOAuthConfigured, getGoogleApiToken, fetchWithTimeout } from './googleOAuth.js';

// The verified Search Console property. Domain properties are 'sc-domain:squideo.com';
// URL-prefix properties are 'https://squideo.com/'. Either works verbatim.
const siteUrl = () => process.env.GSC_SITE_URL;

export function gscConfigured() {
  return googleOAuthConfigured() && !!siteUrl();
}

let ensured = null;
export function ensureGscTables() {
  if (ensured) return ensured;
  ensured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS gsc_totals_daily (
        day         DATE PRIMARY KEY,
        clicks      BIGINT  NOT NULL DEFAULT 0,
        impressions BIGINT  NOT NULL DEFAULT 0,
        ctr         NUMERIC NOT NULL DEFAULT 0,
        position    NUMERIC NOT NULL DEFAULT 0,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS gsc_query_daily (
        day         DATE   NOT NULL,
        query       TEXT   NOT NULL,
        clicks      BIGINT  NOT NULL DEFAULT 0,
        impressions BIGINT  NOT NULL DEFAULT 0,
        position    NUMERIC NOT NULL DEFAULT 0,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (day, query)
      )`;
    await sql`CREATE INDEX IF NOT EXISTS gsc_query_daily_day_idx ON gsc_query_daily(day)`;
  })().catch((err) => { ensured = null; throw err; });
  return ensured;
}

// One Search Analytics query. `dimensions` e.g. ['date'] or ['date','query'].
async function runQuery({ startDate, endDate, dimensions, rowLimit = 25000 }) {
  const token = await getGoogleApiToken();
  const site = encodeURIComponent(siteUrl());
  const r = await fetchWithTimeout(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, dimensions, rowLimit, dataState: 'all' }),
    }
  );
  const json = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error('Search Console query failed (' + r.status + '): ' + (json?.error?.message || 'unknown'));
  }
  return json?.rows || [];
}

// YYYY-MM-DD for `daysAgo` days before today (UTC).
function ymd(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  return d.toISOString().slice(0, 10);
}

// Re-pull the trailing window and upsert both grains. Shared by the daily cron
// and the "Sync now" button.
export async function runGscSync({ days = 30 } = {}) {
  if (!gscConfigured()) return { ok: false, skipped: 'not_configured' };
  await ensureGscTables();
  const startDate = ymd(days);
  const endDate = ymd(0);

  const totals = await runQuery({ startDate, endDate, dimensions: ['date'] });
  await batchWrite(totals.map((row) => {
    const day = row.keys?.[0];
    if (!day) return null;
    return sql`
      INSERT INTO gsc_totals_daily (day, clicks, impressions, ctr, position, updated_at)
      VALUES (${day}, ${Math.round(row.clicks) || 0}, ${Math.round(row.impressions) || 0},
              ${Number(row.ctr) || 0}, ${Number(row.position) || 0}, NOW())
      ON CONFLICT (day) DO UPDATE SET
        clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions,
        ctr = EXCLUDED.ctr, position = EXCLUDED.position, updated_at = NOW()`;
  }));

  const queries = await runQuery({ startDate, endDate, dimensions: ['date', 'query'] });
  await batchWrite(queries.map((row) => {
    const day = row.keys?.[0];
    const query = row.keys?.[1];
    if (!day || query == null) return null;
    return sql`
      INSERT INTO gsc_query_daily (day, query, clicks, impressions, position, updated_at)
      VALUES (${day}, ${query}, ${Math.round(row.clicks) || 0}, ${Math.round(row.impressions) || 0},
              ${Number(row.position) || 0}, NOW())
      ON CONFLICT (day, query) DO UPDATE SET
        clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions,
        position = EXCLUDED.position, updated_at = NOW()`;
  }));

  return { ok: true, days, totalRows: totals.length, queryRows: queries.length };
}

const round2 = (n) => Number((Number(n) || 0).toFixed(2));
const round1 = (n) => Number((Number(n) || 0).toFixed(1));

// Read model for the Marketing → Search tab over [fromStr, toStr) (toStr is the
// exclusive upper bound the analytics route already computes). CTR and average
// position are impression-weighted so any sub-range aggregates correctly.
export async function searchReport(fromStr, toStr) {
  if (!gscConfigured()) return { configured: false, totals: null, series: [], queries: [] };
  await ensureGscTables();

  const [tot] = await sql`
    SELECT COALESCE(SUM(clicks),0)::bigint AS clicks,
           COALESCE(SUM(impressions),0)::bigint AS impressions,
           COALESCE(SUM(position * impressions),0)::numeric AS pos_weight
      FROM gsc_totals_daily
     WHERE day >= ${fromStr}::date AND day < ${toStr}::date`;
  const clicks = Number(tot?.clicks) || 0;
  const impressions = Number(tot?.impressions) || 0;
  const totals = {
    clicks,
    impressions,
    ctr: impressions > 0 ? round2((clicks / impressions) * 100) : 0,
    position: impressions > 0 ? round1(Number(tot.pos_weight) / impressions) : null,
  };

  const series = await sql`
    SELECT day, clicks, impressions
      FROM gsc_totals_daily
     WHERE day >= ${fromStr}::date AND day < ${toStr}::date
     ORDER BY day ASC`;

  const queryRows = await sql`
    SELECT query,
           SUM(clicks)::bigint AS clicks,
           SUM(impressions)::bigint AS impressions,
           SUM(position * impressions)::numeric AS pos_weight
      FROM gsc_query_daily
     WHERE day >= ${fromStr}::date AND day < ${toStr}::date
     GROUP BY query
     ORDER BY clicks DESC, impressions DESC
     LIMIT 100`;
  const queries = queryRows.map((r) => {
    const c = Number(r.clicks) || 0;
    const i = Number(r.impressions) || 0;
    return {
      query: r.query,
      clicks: c,
      impressions: i,
      ctr: i > 0 ? round2((c / i) * 100) : 0,
      position: i > 0 ? round1(Number(r.pos_weight) / i) : null,
    };
  });

  return {
    configured: true,
    totals,
    series: series.map((s) => ({ day: s.day, clicks: Number(s.clicks) || 0, impressions: Number(s.impressions) || 0 })),
    queries,
  };
}

export async function cronGscSync(res) {
  try {
    return res.status(200).json(await runGscSync());
  } catch (err) {
    console.error('[cron gsc-sync]', err?.message);
    return res.status(200).json({ ok: false, error: err?.message || 'sync failed' });
  }
}
