// /api/notifications — the signed-in user's in-app notification feed (the bells).
//
//   GET                        → { items, unread, channels: { finance, general } }
//   POST { all: true }         → mark all the caller's notifications read
//   POST { all: true, channel }→ mark all in that channel ('finance'|'general') read
//   POST { ids: [id, ...] }    → mark those notifications read
//   DELETE                     → clear (delete) all the caller's notifications
//   DELETE ?channel=finance    → clear that channel only
//   DELETE ?id=<id>            → clear that one notification
//
// Each notification belongs to one of two channels (bells) — see
// channelForKey() in _lib/notificationsCatalog.js. The feed splits its latest
// rows + unread counts per channel so the top bar can render a separate £
// (finance) bell beside the general one. Every user reads/writes only their own
// rows (scoped by session email), so this needs auth but no special permission.
import sql from './_lib/db.js';
import { cors, requireAuth } from './_lib/middleware.js';
import { channelForKey, FINANCE_CHANNEL_KEYS, TRACKING_CHANNEL_KEYS } from './_lib/notificationsCatalog.js';

const FEED_LIMIT = 30;

// One-off repair: `tracking.email_opened` alerts created before the clickable
// link shipped (06-11) were persisted with link = NULL, so clicking them did
// nothing. The notification's created_at is essentially simultaneous with the
// email_tracking row's open_notified_at (both written inside notifyFirstOpen),
// so we can recover each alert's thread id by nearest-timestamp match for the
// same user and write back `#/email/<thread>`. Scoped to one user, only touches
// null-link rows, so it self-heals the backlog on the next poll and then no-ops.
// Returns a Map of notificationId -> new link for the rows it fixed.
async function backfillEmailOpenLinks(email) {
  try {
    const rows = await sql`
      UPDATE in_app_notifications n
         SET link = '#/email/' || sub.gmail_thread_id
        FROM (
          SELECT DISTINCT ON (n2.id) n2.id AS notif_id, et.gmail_thread_id
            FROM in_app_notifications n2
            JOIN email_tracking et
              ON et.user_email = n2.user_email
             AND et.gmail_thread_id IS NOT NULL
             AND et.open_notified_at IS NOT NULL
           WHERE n2.user_email = ${email}
             AND n2.notification_key = 'tracking.email_opened'
             AND n2.link IS NULL
             AND ABS(EXTRACT(EPOCH FROM (n2.created_at - et.open_notified_at))) < 120
           ORDER BY n2.id, ABS(EXTRACT(EPOCH FROM (n2.created_at - et.open_notified_at))) ASC
        ) sub
       WHERE n.id = sub.notif_id
      RETURNING n.id, n.link`;
    return new Map(rows.map((r) => [String(r.id), r.link]));
  } catch {
    // email_tracking / open_notified_at may not exist on a fresh workspace.
    return new Map();
  }
}

const mapRow = (r) => ({
  id: String(r.id),
  key: r.notification_key,
  channel: channelForKey(r.notification_key),
  title: r.title,
  body: r.body,
  link: r.link,
  createdAt: r.created_at,
  read: !!r.read_at,
});

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const payload = await requireAuth(req, res);
    if (!payload) return;
    const email = (payload.email || '').toLowerCase();

    if (req.method === 'GET') {
      // Pull the latest rows per channel independently (rather than the latest
      // 30 overall) so a busy channel can't crowd another bell out of its own
      // newest items. General = anything not routed to finance or tracking.
      const [trackingRows, financeRows, generalRows, trackingUnread, financeUnread, generalUnread] = await Promise.all([
        sql`
          SELECT id, notification_key, title, body, link, created_at, read_at
            FROM in_app_notifications
           WHERE user_email = ${email} AND notification_key = ANY(${TRACKING_CHANNEL_KEYS})
           ORDER BY created_at DESC
           LIMIT ${FEED_LIMIT}`,
        sql`
          SELECT id, notification_key, title, body, link, created_at, read_at
            FROM in_app_notifications
           WHERE user_email = ${email} AND notification_key = ANY(${FINANCE_CHANNEL_KEYS})
           ORDER BY created_at DESC
           LIMIT ${FEED_LIMIT}`,
        sql`
          SELECT id, notification_key, title, body, link, created_at, read_at
            FROM in_app_notifications
           WHERE user_email = ${email}
             AND NOT (notification_key = ANY(${FINANCE_CHANNEL_KEYS}))
             AND NOT (notification_key = ANY(${TRACKING_CHANNEL_KEYS}))
           ORDER BY created_at DESC
           LIMIT ${FEED_LIMIT}`,
        sql`
          SELECT COUNT(*)::int AS n FROM in_app_notifications
           WHERE user_email = ${email} AND read_at IS NULL
             AND notification_key = ANY(${TRACKING_CHANNEL_KEYS})`,
        sql`
          SELECT COUNT(*)::int AS n FROM in_app_notifications
           WHERE user_email = ${email} AND read_at IS NULL
             AND notification_key = ANY(${FINANCE_CHANNEL_KEYS})`,
        sql`
          SELECT COUNT(*)::int AS n FROM in_app_notifications
           WHERE user_email = ${email} AND read_at IS NULL
             AND NOT (notification_key = ANY(${FINANCE_CHANNEL_KEYS}))
             AND NOT (notification_key = ANY(${TRACKING_CHANNEL_KEYS}))`,
      ]);

      const tracking = { items: trackingRows.map(mapRow), unread: trackingUnread[0]?.n || 0 };
      // Repair any pre-link email-open alerts still in the feed (no-op once the
      // backlog is healed), then patch the fixed links into this response so the
      // user can click straight through without waiting for the next poll.
      if (tracking.items.some((it) => it.key === 'tracking.email_opened' && !it.link)) {
        const fixed = await backfillEmailOpenLinks(email);
        if (fixed.size) {
          tracking.items = tracking.items.map((it) => (fixed.has(it.id) ? { ...it, link: fixed.get(it.id) } : it));
        }
      }
      const finance = { items: financeRows.map(mapRow), unread: financeUnread[0]?.n || 0 };
      const general = { items: generalRows.map(mapRow), unread: generalUnread[0]?.n || 0 };
      // `items`/`unread` kept for any legacy reader = the general bell's feed.
      return res.status(200).json({
        items: general.items,
        unread: general.unread,
        channels: { tracking, finance, general },
      });
    }

    if (req.method === 'POST') {
      const { ids, all, channel } = req.body || {};
      if (all) {
        if (channel === 'tracking') {
          await sql`UPDATE in_app_notifications SET read_at = NOW()
                     WHERE user_email = ${email} AND read_at IS NULL
                       AND notification_key = ANY(${TRACKING_CHANNEL_KEYS})`;
        } else if (channel === 'finance') {
          await sql`UPDATE in_app_notifications SET read_at = NOW()
                     WHERE user_email = ${email} AND read_at IS NULL
                       AND notification_key = ANY(${FINANCE_CHANNEL_KEYS})`;
        } else if (channel === 'general') {
          await sql`UPDATE in_app_notifications SET read_at = NOW()
                     WHERE user_email = ${email} AND read_at IS NULL
                       AND NOT (notification_key = ANY(${FINANCE_CHANNEL_KEYS}))
                       AND NOT (notification_key = ANY(${TRACKING_CHANNEL_KEYS}))`;
        } else {
          await sql`UPDATE in_app_notifications SET read_at = NOW()
                     WHERE user_email = ${email} AND read_at IS NULL`;
        }
        return res.status(200).json({ ok: true });
      }
      const numeric = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite);
      if (!numeric.length) return res.status(400).json({ error: 'Provide ids[] or all:true' });
      await sql`UPDATE in_app_notifications SET read_at = NOW()
                 WHERE user_email = ${email} AND id = ANY(${numeric}) AND read_at IS NULL`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const id = Number(req.query?.id);
      const channel = req.query?.channel;
      if (Number.isFinite(id)) {
        await sql`DELETE FROM in_app_notifications WHERE user_email = ${email} AND id = ${id}`;
      } else if (channel === 'tracking') {
        await sql`DELETE FROM in_app_notifications WHERE user_email = ${email}
                   AND notification_key = ANY(${TRACKING_CHANNEL_KEYS})`;
      } else if (channel === 'finance') {
        await sql`DELETE FROM in_app_notifications WHERE user_email = ${email}
                   AND notification_key = ANY(${FINANCE_CHANNEL_KEYS})`;
      } else if (channel === 'general') {
        await sql`DELETE FROM in_app_notifications WHERE user_email = ${email}
                   AND NOT (notification_key = ANY(${FINANCE_CHANNEL_KEYS}))
                   AND NOT (notification_key = ANY(${TRACKING_CHANNEL_KEYS}))`;
      } else {
        await sql`DELETE FROM in_app_notifications WHERE user_email = ${email}`;
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).end();
  } catch (err) {
    console.error('[notifications] handler error', err);
    if (!res.headersSent) return res.status(500).json({ error: 'Server error' });
  }
}
