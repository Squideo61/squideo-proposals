// Web Push (Tier 2) — true background desktop notifications that fire even when
// no Squideo tab is open. Subscriptions (one row per browser/device) are stored
// in push_subscriptions; the cron + every in-app notification fan out to them
// here via sendWebPush().
//
// Pairs with the client: public/sw.js (the service worker that receives the
// push and calls showNotification) and src/lib/pushSubscribe.js (registers the
// SW and posts its subscription to /api/push).
//
// Requires three env vars; without them push is a graceful no-op so dev and any
// un-provisioned deploy keep working:
//   VAPID_PUBLIC_KEY   — also served to the browser via /api/push?action=public-key
//   VAPID_PRIVATE_KEY  — server only
//   VAPID_SUBJECT      — 'mailto:you@domain' or your site URL
import webpush from 'web-push';
import sql from './db.js';

let configured = null; // null = not yet attempted, true/false = result

function ensureConfigured() {
  if (configured !== null) return configured;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:adam@squideo.co.uk';
  if (!pub || !priv) {
    configured = false;
    return false;
  }
  try {
    webpush.setVapidDetails(subject, pub, priv);
    configured = true;
  } catch (err) {
    console.warn('[push] VAPID config failed', err.message);
    configured = false;
  }
  return configured;
}

export function pushConfigured() {
  return ensureConfigured();
}

export function vapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

// Idempotent table create so push works without a manual migration step (a
// matching file lives in db/migrations for the record). Cheap; runs once per
// cold start at most because of the module-level guard below.
let tableReady = false;
export async function ensurePushTable() {
  if (tableReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint   TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_email)`;
  tableReady = true;
}

export async function saveSubscription(email, subscription) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error('Invalid subscription');
  }
  await ensurePushTable();
  await sql`
    INSERT INTO push_subscriptions (endpoint, user_email, p256dh, auth)
    VALUES (${subscription.endpoint}, ${email.toLowerCase()}, ${subscription.keys.p256dh}, ${subscription.keys.auth})
    ON CONFLICT (endpoint) DO UPDATE
      SET user_email = EXCLUDED.user_email,
          p256dh = EXCLUDED.p256dh,
          auth = EXCLUDED.auth`;
}

export async function removeSubscription(endpoint) {
  if (!endpoint) return;
  await ensurePushTable();
  await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`;
}

// Fan a payload out to every subscription belonging to `recipients` (array of
// emails). Dead subscriptions (410 Gone / 404) are pruned. Best-effort: a push
// failure must never break the caller (email + in-app are the durable paths).
export async function sendWebPush(recipients, { title, body, link, tag } = {}) {
  if (!ensureConfigured()) return { sent: 0 };
  const emails = Array.from(new Set((recipients || []).filter(Boolean).map(e => String(e).toLowerCase())));
  if (!emails.length) return { sent: 0 };

  try {
    await ensurePushTable();
    const subs = await sql`
      SELECT endpoint, p256dh, auth FROM push_subscriptions
       WHERE user_email = ANY(${emails})`;
    if (!subs.length) return { sent: 0 };

    const payload = JSON.stringify({ title, body: body || null, link: link || null, tag: tag || null });
    const results = await Promise.allSettled(
      subs.map((s) =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        ).catch((err) => {
          // Mark gone subscriptions for pruning, then rethrow so allSettled
          // records the rejection.
          if (err?.statusCode === 410 || err?.statusCode === 404) err._prune = s.endpoint;
          throw err;
        }),
      ),
    );

    const dead = results
      .filter(r => r.status === 'rejected' && r.reason?._prune)
      .map(r => r.reason._prune);
    if (dead.length) {
      await sql`DELETE FROM push_subscriptions WHERE endpoint = ANY(${dead})`;
    }
    const sent = results.filter(r => r.status === 'fulfilled').length;
    return { sent };
  } catch (err) {
    console.warn('[push] sendWebPush failed', err.message);
    return { sent: 0 };
  }
}
