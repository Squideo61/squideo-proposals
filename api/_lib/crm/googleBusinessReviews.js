// Google Business Profile reviews sync — pulls our own Google reviews so the
// /reviews embed on squideo.com shows the real thing instead of a list someone
// retyped by hand and forgot to update.
//
// Reviews live on the LEGACY v4 API (mybusiness.googleapis.com). The eight
// newer Business Profile APIs never got a reviews surface, so v4 is not a
// shortcut here — it's the only option. Discovery of the account + location
// does use the new APIs, because v4's own account/location listing is gone.
//
// Access is allowlisted per Cloud project: default quota is 0 QPM until Google
// approves the project. Until then every call 403s, which is what
// reviewsConfigured() and the status row are for.
//
// Nothing here is published automatically. The sync only ever writes what
// Google returned; `approved` is a human decision made in Admin → Reviews, and
// the public endpoint serves approved rows only. A five-star review from a
// stranger is still someone else's words going on our homepage unattended.
import sql, { batchWrite } from '../db.js';
import { fetchWithTimeout } from './googleOAuth.js';
import { recordSyncStatus, getSyncStatus } from './marketingSyncStatus.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';

// Own credentials if the allowlisted project is a different one from the
// project behind the GA4 / Search Console token; otherwise fall through to the
// shared Google OAuth client, which only needs the business.manage scope added.
const clientId = () =>
  process.env.GOOGLE_BUSINESS_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_ADS_CLIENT_ID;
const clientSecret = () =>
  process.env.GOOGLE_BUSINESS_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_ADS_CLIENT_SECRET;
const refreshToken = () =>
  process.env.GOOGLE_BUSINESS_REFRESH_TOKEN || process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

export function reviewsConfigured() {
  return !!(clientId() && clientSecret() && refreshToken());
}

// Separate cache from googleOAuth.js: this token may carry a different scope
// set, and handing a business.manage-less token to the reviews API produces a
// 403 that reads exactly like "not allowlisted yet".
const tokenCache = new Map(); // refreshToken -> { value, expiresAt }

async function getBusinessApiToken() {
  const rt = refreshToken();
  if (!clientId() || !clientSecret() || !rt) throw new Error('Google Business Profile OAuth is not configured');
  const hit = tokenCache.get(rt);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.value;
  const r = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: rt,
    }),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.access_token) {
    throw new Error('Google OAuth failed: ' + (json.error_description || json.error || r.status));
  }
  tokenCache.set(rt, { value: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 });
  return json.access_token;
}

async function apiGet(url) {
  const token = await getBusinessApiToken();
  const r = await fetchWithTimeout(url, { headers: { Authorization: 'Bearer ' + token } });
  const json = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = json?.error?.message || 'unknown error';
    // A 403 here almost always means the project has not been allowlisted
    // (quota 0 QPM) rather than anything being wrong with the token, and that
    // distinction costs an hour to work out from the raw message alone.
    if (r.status === 403) {
      throw new Error(
        'Google refused the request (403): ' + msg + '. If the project was only just approved, ' +
        'check the Google My Business API is enabled in the Cloud console and that quota reads 300 QPM.'
      );
    }
    throw new Error('Google Business Profile API ' + r.status + ': ' + msg);
  }
  return json;
}

/* ------------------------------------------------------------------ schema */

let ensured = null;
export function ensureReviewTables() {
  if (ensured) return ensured;
  ensured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS google_reviews (
        review_id      TEXT PRIMARY KEY,
        reviewer_name  TEXT,
        reviewer_photo TEXT,
        is_anonymous   BOOLEAN NOT NULL DEFAULT FALSE,
        star_rating    SMALLINT NOT NULL DEFAULT 0,
        comment        TEXT,
        create_time    TIMESTAMPTZ,
        update_time    TIMESTAMPTZ,
        approved       BOOLEAN,
        approved_by    TEXT,
        approved_at    TIMESTAMPTZ,
        display_text   TEXT,
        sort_order     INTEGER,
        synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        gone_at        TIMESTAMPTZ
      )`;
    await sql`CREATE INDEX IF NOT EXISTS google_reviews_display_idx
                ON google_reviews(approved, star_rating, gone_at)`;
    await sql`
      CREATE TABLE IF NOT EXISTS google_reviews_meta (
        id             SMALLINT PRIMARY KEY DEFAULT 1,
        account_name   TEXT,
        location_name  TEXT,
        location_title TEXT,
        average_rating NUMERIC,
        total_count    INTEGER,
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
  })().catch((err) => { ensured = null; throw err; });
  return ensured;
}

// Notes on two columns that aren't self-evident:
//
// `approved` is deliberately tri-state. NULL = never looked at, true = cleared
// for the homepage, false = explicitly rejected. A rejected review has to stay
// rejected when it resurfaces in tomorrow's sync, which a plain boolean
// defaulting to false could not express.
//
// `gone_at` is set when a review stops coming back from Google — deleted by its
// author, or pulled by Google. The row survives so that an approved review
// disappearing from the banner is explainable rather than mysterious.

/* --------------------------------------------------------------- discovery */

// v4 needs accounts/{id}/locations/{id}. The v4 account and location listings
// were retired, so both come from the newer APIs and get cached — they never
// change for a single-location business, and re-deriving them on every sync
// would burn two calls a night for nothing.
async function discoverLocation({ force = false } = {}) {
  await ensureReviewTables();

  const envAccount = process.env.GBP_ACCOUNT_NAME;   // e.g. 'accounts/123456'
  const envLocation = process.env.GBP_LOCATION_NAME; // e.g. 'locations/789012'
  if (envAccount && envLocation) {
    return { accountName: envAccount, locationName: envLocation, locationTitle: null };
  }

  if (!force) {
    const [row] = await sql`SELECT account_name, location_name, location_title FROM google_reviews_meta WHERE id = 1`;
    if (row?.account_name && row?.location_name) {
      return { accountName: row.account_name, locationName: row.location_name, locationTitle: row.location_title };
    }
  }

  const accounts = await apiGet('https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
  const account = accounts?.accounts?.[0];
  if (!account?.name) throw new Error('No Business Profile accounts are visible to this Google account');

  const locs = await apiGet(
    'https://mybusinessbusinessinformation.googleapis.com/v1/' + account.name + '/locations' +
    '?readMask=name,title&pageSize=100'
  );
  const location = locs?.locations?.[0];
  if (!location?.name) throw new Error('No locations found under ' + account.name);

  if (locs.locations.length > 1) {
    // Single-location business today. If that ever changes this picks the first
    // one silently, so say so rather than let the homepage quietly show reviews
    // for whichever location Google happened to list first.
    console.warn('[google reviews] ' + locs.locations.length + ' locations found; using ' + location.name +
                 '. Set GBP_LOCATION_NAME to pin a specific one.');
  }

  await sql`
    INSERT INTO google_reviews_meta (id, account_name, location_name, location_title, updated_at)
    VALUES (1, ${account.name}, ${location.name}, ${location.title || null}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      account_name = EXCLUDED.account_name,
      location_name = EXCLUDED.location_name,
      location_title = EXCLUDED.location_title,
      updated_at = NOW()`;

  return { accountName: account.name, locationName: location.name, locationTitle: location.title || null };
}

/* ------------------------------------------------------------------- fetch */

const STARS = { STAR_RATING_UNSPECIFIED: 0, ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

// v4 wants the bare location id; the newer APIs hand back 'locations/{id}'.
const bareId = (name) => String(name || '').split('/').pop();

async function fetchAllReviews({ accountName, locationName }) {
  const base = 'https://mybusiness.googleapis.com/v4/' + accountName +
               '/locations/' + bareId(locationName) + '/reviews';
  const all = [];
  let pageToken = null;
  let averageRating = null;
  let totalCount = null;
  let pages = 0;

  do {
    const url = base + '?pageSize=50' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const json = await apiGet(url);
    for (const rv of json?.reviews || []) all.push(rv);
    // Google reports these on every page; the first is as good as any.
    if (averageRating == null && json?.averageRating != null) averageRating = Number(json.averageRating);
    if (totalCount == null && json?.totalReviewCount != null) totalCount = Number(json.totalReviewCount);
    pageToken = json?.nextPageToken || null;
    pages += 1;
    // ~50 reviews a page, so this is a guard rather than an expected limit:
    // without it a malformed nextPageToken loop runs until the function dies.
    if (pages >= 40) break;
  } while (pageToken);

  return { reviews: all, averageRating, totalCount };
}

/* -------------------------------------------------------------------- sync */

export async function runReviewSync() {
  if (!reviewsConfigured()) return { ok: false, skipped: 'not_configured' };
  await ensureReviewTables();

  const loc = await discoverLocation();
  const { reviews, averageRating, totalCount } = await fetchAllReviews(loc);

  const seen = [];
  // approved / display_text are deliberately absent from the UPDATE list: a
  // re-sync must never silently un-approve a review or discard a hand-trimmed
  // card. An edited review keeps its old display_text until someone looks.
  await batchWrite(reviews.map((rv) => {
    const id = rv.reviewId || bareId(rv.name);
    if (!id) return null;
    seen.push(id);
    const stars = STARS[rv.starRating] ?? 0;
    const anon = !!rv.reviewer?.isAnonymous;
    return sql`
      INSERT INTO google_reviews (
        review_id, reviewer_name, reviewer_photo, is_anonymous,
        star_rating, comment, create_time, update_time, synced_at, gone_at
      ) VALUES (
        ${id}, ${anon ? null : (rv.reviewer?.displayName || null)},
        ${anon ? null : (rv.reviewer?.profilePhotoUrl || null)}, ${anon},
        ${stars}, ${rv.comment || null},
        ${rv.createTime || null}, ${rv.updateTime || null}, NOW(), NULL
      )
      ON CONFLICT (review_id) DO UPDATE SET
        reviewer_name  = EXCLUDED.reviewer_name,
        reviewer_photo = EXCLUDED.reviewer_photo,
        is_anonymous   = EXCLUDED.is_anonymous,
        star_rating    = EXCLUDED.star_rating,
        comment        = EXCLUDED.comment,
        update_time    = EXCLUDED.update_time,
        synced_at      = NOW(),
        gone_at        = NULL`;
  }));

  // Reviews that stopped coming back have been deleted upstream. Flagged, not
  // deleted, so an approved one vanishing from the banner is traceable.
  if (seen.length) {
    await sql`UPDATE google_reviews SET gone_at = NOW()
               WHERE gone_at IS NULL AND review_id <> ALL(${seen})`;
  }

  await sql`
    INSERT INTO google_reviews_meta (id, account_name, location_name, location_title, average_rating, total_count, updated_at)
    VALUES (1, ${loc.accountName}, ${loc.locationName}, ${loc.locationTitle}, ${averageRating}, ${totalCount}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      average_rating = EXCLUDED.average_rating,
      total_count    = EXCLUDED.total_count,
      updated_at     = NOW()`;

  const [counts] = await sql`
    SELECT COUNT(*) FILTER (WHERE approved IS NULL AND star_rating = 5 AND COALESCE(comment,'') <> '')::int AS pending
      FROM google_reviews WHERE gone_at IS NULL`;

  return { ok: true, rows: reviews.length, averageRating, totalCount, pending: counts?.pending || 0 };
}

/* --------------------------------------------------------------- read side */

const shapePublic = (r) => ({
  id: r.review_id,
  name: r.reviewer_name || 'Google reviewer',
  stars: r.star_rating,
  text: r.display_text || r.comment,
  photo: r.reviewer_photo || null,
  source: 'google',
});

// What the /reviews embed renders. Approved and still-present only; a review
// with no words is nothing to show.
export async function publicReviews() {
  await ensureReviewTables();
  const rows = await sql`
    SELECT review_id, reviewer_name, reviewer_photo, star_rating, comment, display_text
      FROM google_reviews
     WHERE approved IS TRUE
       AND gone_at IS NULL
       AND COALESCE(display_text, comment, '') <> ''
     ORDER BY sort_order NULLS LAST, update_time DESC NULLS LAST`;
  const [meta] = await sql`SELECT average_rating, total_count FROM google_reviews_meta WHERE id = 1`;
  return {
    reviews: rows.map(shapePublic),
    summary: meta?.total_count
      ? {
          rating: meta.average_rating == null ? null : Number(meta.average_rating).toFixed(1),
          count: Number(meta.total_count),
          source: 'google',
        }
      : null,
  };
}

// Admin moderation list. `filter` is 'pending' | 'approved' | 'rejected' | 'all'.
export async function adminListReviews({ filter = 'pending' } = {}) {
  await ensureReviewTables();
  const rows = await sql`
    SELECT review_id, reviewer_name, reviewer_photo, is_anonymous, star_rating,
           comment, display_text, create_time, update_time, approved, approved_by,
           approved_at, sort_order, gone_at
      FROM google_reviews
     WHERE gone_at IS NULL
       AND (${filter}::text = 'all'
            OR (${filter}::text = 'pending'  AND approved IS NULL)
            OR (${filter}::text = 'approved' AND approved IS TRUE)
            OR (${filter}::text = 'rejected' AND approved IS FALSE))
     ORDER BY star_rating DESC, update_time DESC NULLS LAST
     LIMIT 500`;
  const [counts] = await sql`
    SELECT COUNT(*) FILTER (WHERE approved IS NULL)::int  AS pending,
           COUNT(*) FILTER (WHERE approved IS TRUE)::int  AS approved,
           COUNT(*) FILTER (WHERE approved IS FALSE)::int AS rejected
      FROM google_reviews WHERE gone_at IS NULL`;
  const [meta] = await sql`
    SELECT location_title, average_rating, total_count, updated_at
      FROM google_reviews_meta WHERE id = 1`;
  return {
    configured: reviewsConfigured(),
    reviews: rows.map((r) => ({
      id: r.review_id,
      name: r.reviewer_name,
      photo: r.reviewer_photo,
      anonymous: r.is_anonymous,
      stars: r.star_rating,
      comment: r.comment,
      displayText: r.display_text,
      approved: r.approved,
      approvedBy: r.approved_by,
      approvedAt: r.approved_at,
      createTime: r.create_time,
      updateTime: r.update_time,
    })),
    counts: counts || { pending: 0, approved: 0, rejected: 0 },
    meta: meta || null,
  };
}

export async function setReviewApproval(ids, approved, userName) {
  await ensureReviewTables();
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
  if (!list.length) return { ok: true, updated: 0 };
  const rows = await sql`
    UPDATE google_reviews
       SET approved = ${approved === null ? null : !!approved},
           approved_by = ${approved === null ? null : (userName || null)},
           approved_at = ${approved === null ? null : new Date().toISOString()}
     WHERE review_id = ANY(${list})
     RETURNING review_id`;
  return { ok: true, updated: rows.length };
}

// Hand-trimmed card text. An empty string clears the override and falls back to
// the review as Google has it.
export async function setReviewText(id, text) {
  await ensureReviewTables();
  const trimmed = (text || '').trim();
  await sql`UPDATE google_reviews SET display_text = ${trimmed || null} WHERE review_id = ${String(id)}`;
  return { ok: true };
}

export async function rediscoverLocation() {
  const loc = await discoverLocation({ force: true });
  return { ok: true, ...loc };
}

/* -------------------------------------------------------------------- cron */

export async function cronGoogleReviewsSync(res) {
  try {
    const r = await runReviewSync();
    await recordSyncStatus('google-reviews', r);
    return res.status(200).json(r);
  } catch (err) {
    await recordSyncStatus('google-reviews', err);
    console.error('[cron google-reviews-sync]', err?.message);
    return res.status(200).json({ ok: false, error: err?.message || 'sync failed' });
  }
}

/* ------------------------------------------------------------------- route */

// /api/crm/reviews — Admin → Reviews moderation. Behind settings.manage, the
// same gate as the other things that change what the public site shows.
export async function reviewsRoute(req, res, id, action, user) {
  const role = await getRole(user.role);
  if (!hasPermission(role, 'settings.manage')) {
    return res.status(403).json({ error: 'You do not have permission to manage reviews' });
  }

  if (!id) {
    if (req.method !== 'GET') return res.status(405).end();
    const filter = (req.query?.filter || 'pending').toString();
    const data = await adminListReviews({ filter });
    return res.status(200).json({ ...data, status: await getSyncStatus('google-reviews') });
  }

  // POST /api/crm/reviews/sync — pull from Google on demand. The nightly cron
  // does the same thing; this exists so the first run doesn't wait until 4am
  // and so a failure is readable straight away instead of only in the logs.
  if (id === 'sync') {
    if (req.method !== 'POST') return res.status(405).end();
    try {
      const r = await runReviewSync();
      await recordSyncStatus('google-reviews', r);
      return res.status(200).json(r);
    } catch (err) {
      await recordSyncStatus('google-reviews', err);
      return res.status(200).json({ ok: false, error: err?.message || 'sync failed' });
    }
  }

  if (id === 'rediscover') {
    if (req.method !== 'POST') return res.status(405).end();
    try {
      return res.status(200).json(await rediscoverLocation());
    } catch (err) {
      return res.status(200).json({ ok: false, error: err?.message || 'lookup failed' });
    }
  }

  if (id === 'approve') {
    if (req.method !== 'POST') return res.status(405).end();
    const { ids, approved } = req.body || {};
    const value = approved === null ? null : !!approved;
    return res.status(200).json(await setReviewApproval(ids, value, user?.name || user?.email || null));
  }

  if (action === 'text') {
    if (req.method !== 'PATCH' && req.method !== 'POST') return res.status(405).end();
    return res.status(200).json(await setReviewText(id, (req.body || {}).text));
  }

  return res.status(404).json({ error: 'Unknown reviews action' });
}
