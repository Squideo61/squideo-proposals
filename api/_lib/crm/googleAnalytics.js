// Google Analytics 4 sync — pulls sitewide traffic (sessions, users, key events)
// broken down by GA4's default channel grouping, so Marketing can show total
// site traffic per channel alongside our own lead numbers. GA4's
// sessionDefaultChannelGroup (Direct, Organic Search, Paid Search, Organic
// Social, Email, Referral, …) lines up with how we classify leads, so the two
// can be read side by side.
//
// Gated behind ga4Configured(): until the OAuth token + GA4_PROPERTY_ID are
// present, the cron no-ops and the report renders empty with a "connect" hint.
import sql, { batchWrite } from '../db.js';
import { googleOAuthConfigured, getGoogleApiToken, fetchWithTimeout } from './googleOAuth.js';
import { recordSyncStatus } from './marketingSyncStatus.js';

const digits = (s) => String(s || '').replace(/[^0-9]/g, '');
const propertyId = () => digits(process.env.GA4_PROPERTY_ID);

export function ga4Configured() {
  return googleOAuthConfigured() && !!propertyId();
}

let ensured = null;
export function ensureGa4Tables() {
  if (ensured) return ensured;
  ensured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS ga4_channel_daily (
        day        DATE   NOT NULL,
        channel    TEXT   NOT NULL,
        sessions   BIGINT NOT NULL DEFAULT 0,
        users      BIGINT NOT NULL DEFAULT 0,
        key_events NUMERIC NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (day, channel)
      )`;
    await sql`CREATE INDEX IF NOT EXISTS ga4_channel_daily_day_idx ON ga4_channel_daily(day)`;
  })().catch((err) => { ensured = null; throw err; });
  return ensured;
}

// Run a GA4 Data API report. Returns the raw rows array.
async function runReport(body) {
  const token = await getGoogleApiToken();
  const r = await fetchWithTimeout(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId()}:runReport`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  const json = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error('GA4 query failed (' + r.status + '): ' + (json?.error?.message || 'unknown'));
  }
  return json?.rows || [];
}

// GA4 returns the date dimension as 'YYYYMMDD' → 'YYYY-MM-DD'.
function dashDate(s) {
  const d = digits(s);
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
}

export async function runGa4Sync({ days = 30 } = {}) {
  if (!ga4Configured()) return { ok: false, skipped: 'not_configured' };
  await ensureGa4Tables();
  const rows = await runReport({
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
    dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'keyEvents' }],
    limit: 100000,
  });

  const writes = rows.map((row) => {
    const day = dashDate(row.dimensionValues?.[0]?.value);
    const channel = row.dimensionValues?.[1]?.value || '(other)';
    if (!day) return null;
    const m = row.metricValues || [];
    return sql`
      INSERT INTO ga4_channel_daily (day, channel, sessions, users, key_events, updated_at)
      VALUES (${day}, ${channel}, ${Math.round(Number(m[0]?.value)) || 0},
              ${Math.round(Number(m[1]?.value)) || 0}, ${Number(m[2]?.value) || 0}, NOW())
      ON CONFLICT (day, channel) DO UPDATE SET
        sessions = EXCLUDED.sessions, users = EXCLUDED.users,
        key_events = EXCLUDED.key_events, updated_at = NOW()`;
  }).filter(Boolean);
  await batchWrite(writes);
  return { ok: true, days, rows: writes.length };
}

const round2 = (n) => Number((Number(n) || 0).toFixed(2));

// Read model for the Marketing → Traffic tab over [fromStr, toStr).
export async function trafficReport(fromStr, toStr) {
  if (!ga4Configured()) return { configured: false, totals: null, channels: [], series: [] };
  await ensureGa4Tables();

  const channelRows = await sql`
    SELECT channel,
           SUM(sessions)::bigint AS sessions,
           SUM(users)::bigint AS users,
           SUM(key_events)::numeric AS key_events
      FROM ga4_channel_daily
     WHERE day >= ${fromStr}::date AND day < ${toStr}::date
     GROUP BY channel
     ORDER BY sessions DESC`;
  const channels = channelRows.map((r) => ({
    channel: r.channel,
    sessions: Number(r.sessions) || 0,
    users: Number(r.users) || 0,
    keyEvents: round2(r.key_events),
  }));

  const totals = channels.reduce(
    (acc, c) => ({ sessions: acc.sessions + c.sessions, users: acc.users + c.users, keyEvents: round2(acc.keyEvents + c.keyEvents) }),
    { sessions: 0, users: 0, keyEvents: 0 }
  );

  const seriesRows = await sql`
    SELECT day, SUM(sessions)::bigint AS sessions
      FROM ga4_channel_daily
     WHERE day >= ${fromStr}::date AND day < ${toStr}::date
     GROUP BY day
     ORDER BY day ASC`;

  return {
    configured: true,
    totals,
    channels,
    series: seriesRows.map((s) => ({ day: s.day, sessions: Number(s.sessions) || 0 })),
  };
}

export async function cronGa4Sync(res) {
  try {
    const r = await runGa4Sync();
    await recordSyncStatus('ga4', r);
    return res.status(200).json(r);
  } catch (err) {
    await recordSyncStatus('ga4', err);
    console.error('[cron ga4-sync]', err?.message);
    return res.status(200).json({ ok: false, error: err?.message || 'sync failed' });
  }
}
