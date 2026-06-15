// Lead attribution — shared between the public quote-form endpoint
// (api/quote-requests.js, which writes it) and the Marketing analytics route
// (api/_lib/crm/analytics.js, which reads it).
//
// track.js (served from /track.js, embedded on squideo.com) captures first-touch
// attribution on the marketing site and posts it into the quote-form iframe; the
// form forwards it as `body.attribution`. We re-derive the channel server-side —
// never trust the client's classification.
import sql from './db.js';

// camelCase field (as emitted by track.js / sent by the form) -> DB column.
// This is the single source of truth for which attribution fields we persist.
const FIELD_TO_COLUMN = {
  source: 'attr_source',
  medium: 'attr_medium',
  campaign: 'attr_campaign',
  term: 'attr_term',
  content: 'attr_content',
  gclid: 'attr_gclid',
  gbraid: 'attr_gbraid',
  wbraid: 'attr_wbraid',
  fbclid: 'attr_fbclid',
  msclkid: 'attr_msclkid',
  campaignId: 'attr_campaign_id',
  adgroupId: 'attr_adgroup_id',
  keyword: 'attr_keyword',
  matchtype: 'attr_matchtype',
  network: 'attr_network',
  device: 'attr_device',
  landingUrl: 'attr_landing_url',
  referrer: 'attr_referrer',
};

const MAX_LEN = 512;
const clip = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > MAX_LEN ? s.slice(0, MAX_LEN) : s;
};

const SEARCH_ENGINE_RE = /(^|\.)(google|bing|yahoo|duckduckgo|ecosia|baidu|yandex|ask|aol)\./i;
const SOCIAL_RE = /(^|\.)(facebook|instagram|fb|t\.co|twitter|x\.com|linkedin|lnkd|youtube|tiktok|pinterest|reddit)\./i;

function refHost(referrer) {
  if (!referrer) return '';
  try { return new URL(referrer).hostname.toLowerCase(); } catch { return ''; }
}

// Authoritative channel classification (the client sends its own guess; we ignore
// it). Order matters: a paid click id always wins, then paid medium, then social,
// then organic, then any external referrer, else direct.
export function deriveChannel(a) {
  const medium = (a.medium || '').toLowerCase();
  const host = refHost(a.referrer);
  if (a.gclid || a.gbraid || a.wbraid || a.msclkid) return 'paid_search';
  if (/(^|[-_ ])(cpc|ppc|paid|sem|paidsearch)([-_ ]|$)/.test(medium)) return 'paid_search';
  if (a.fbclid || /social/.test(medium) || (host && SOCIAL_RE.test(host))) return 'social';
  if (medium === 'organic' || (host && SEARCH_ENGINE_RE.test(host))) return 'organic';
  if (host) return 'referral';
  return 'direct';
}

// Normalise body.attribution into a DB-ready { column: value } map (+ derived
// channel + first_seen_at), or null when there's nothing usable. Returns column
// keys so callers can spread straight into an INSERT builder.
export function pickAttribution(body) {
  const a = body && typeof body.attribution === 'object' && body.attribution ? body.attribution : null;
  if (!a) return null;
  const out = {};
  let any = false;
  for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
    const v = clip(a[field]);
    if (v != null) { out[column] = v; any = true; }
  }
  if (!any) return null;
  // Re-derive channel from the cleaned values (don't trust a.channel).
  out.attr_channel = deriveChannel({
    medium: out.attr_medium, referrer: out.attr_referrer,
    gclid: out.attr_gclid, gbraid: out.attr_gbraid, wbraid: out.attr_wbraid,
    msclkid: out.attr_msclkid, fbclid: out.attr_fbclid,
  });
  // first_seen_at: trust a sane client timestamp, else stamp now.
  const ts = Number(a.firstSeenAt);
  out.attr_first_seen_at = Number.isFinite(ts) && ts > 0 && ts < Date.now() + 86400000
    ? new Date(ts) : new Date();
  return out;
}

// Self-heal the attribution columns so the first attributed lead can't hit a
// missing column even if 20260615_lead_attribution.sql wasn't run. Memoised per
// cold start; mirrors ensureSalesPpsHistory() in stats.js.
let ensured = null;
export function ensureLeadAttribution() {
  if (ensured) return ensured;
  ensured = (async () => {
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_channel       TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_source        TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_medium        TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_campaign      TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_term          TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_content       TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_gclid         TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_gbraid        TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_wbraid        TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_fbclid        TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_msclkid       TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_campaign_id   TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_adgroup_id    TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_keyword       TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_matchtype     TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_network       TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_device        TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_landing_url   TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_referrer      TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS attr_first_seen_at TIMESTAMPTZ`;
    await sql`CREATE INDEX IF NOT EXISTS quote_requests_attr_channel_idx  ON quote_requests(attr_channel)`;
    await sql`CREATE INDEX IF NOT EXISTS quote_requests_attr_campaign_idx ON quote_requests(attr_campaign_id)`;
    await sql`ALTER TABLE quote_request_partials ADD COLUMN IF NOT EXISTS attr_channel     TEXT`;
    await sql`ALTER TABLE quote_request_partials ADD COLUMN IF NOT EXISTS attr_source      TEXT`;
    await sql`ALTER TABLE quote_request_partials ADD COLUMN IF NOT EXISTS attr_medium      TEXT`;
    await sql`ALTER TABLE quote_request_partials ADD COLUMN IF NOT EXISTS attr_campaign    TEXT`;
    await sql`ALTER TABLE quote_request_partials ADD COLUMN IF NOT EXISTS attr_campaign_id TEXT`;
    await sql`ALTER TABLE quote_request_partials ADD COLUMN IF NOT EXISTS attr_keyword     TEXT`;
    await sql`ALTER TABLE quote_request_partials ADD COLUMN IF NOT EXISTS attr_gclid       TEXT`;
  })().catch((err) => { ensured = null; throw err; });
  return ensured;
}
