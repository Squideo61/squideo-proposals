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
import { channelForKey, FINANCE_CHANNEL_KEYS } from './_lib/notificationsCatalog.js';

const FEED_LIMIT = 30;

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
      // 30 overall) so a busy finance feed can't crowd the general bell — or
      // vice versa — out of its own newest items.
      const [financeRows, generalRows, financeUnread, generalUnread] = await Promise.all([
        sql`
          SELECT id, notification_key, title, body, link, created_at, read_at
            FROM in_app_notifications
           WHERE user_email = ${email} AND notification_key = ANY(${FINANCE_CHANNEL_KEYS})
           ORDER BY created_at DESC
           LIMIT ${FEED_LIMIT}`,
        sql`
          SELECT id, notification_key, title, body, link, created_at, read_at
            FROM in_app_notifications
           WHERE user_email = ${email} AND NOT (notification_key = ANY(${FINANCE_CHANNEL_KEYS}))
           ORDER BY created_at DESC
           LIMIT ${FEED_LIMIT}`,
        sql`
          SELECT COUNT(*)::int AS n FROM in_app_notifications
           WHERE user_email = ${email} AND read_at IS NULL
             AND notification_key = ANY(${FINANCE_CHANNEL_KEYS})`,
        sql`
          SELECT COUNT(*)::int AS n FROM in_app_notifications
           WHERE user_email = ${email} AND read_at IS NULL
             AND NOT (notification_key = ANY(${FINANCE_CHANNEL_KEYS}))`,
      ]);

      const finance = { items: financeRows.map(mapRow), unread: financeUnread[0]?.n || 0 };
      const general = { items: generalRows.map(mapRow), unread: generalUnread[0]?.n || 0 };
      // `items`/`unread` kept for any legacy reader = the general bell's feed.
      return res.status(200).json({
        items: general.items,
        unread: general.unread,
        channels: { finance, general },
      });
    }

    if (req.method === 'POST') {
      const { ids, all, channel } = req.body || {};
      if (all) {
        if (channel === 'finance') {
          await sql`UPDATE in_app_notifications SET read_at = NOW()
                     WHERE user_email = ${email} AND read_at IS NULL
                       AND notification_key = ANY(${FINANCE_CHANNEL_KEYS})`;
        } else if (channel === 'general') {
          await sql`UPDATE in_app_notifications SET read_at = NOW()
                     WHERE user_email = ${email} AND read_at IS NULL
                       AND NOT (notification_key = ANY(${FINANCE_CHANNEL_KEYS}))`;
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
      } else if (channel === 'finance') {
        await sql`DELETE FROM in_app_notifications WHERE user_email = ${email}
                   AND notification_key = ANY(${FINANCE_CHANNEL_KEYS})`;
      } else if (channel === 'general') {
        await sql`DELETE FROM in_app_notifications WHERE user_email = ${email}
                   AND NOT (notification_key = ANY(${FINANCE_CHANNEL_KEYS}))`;
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
