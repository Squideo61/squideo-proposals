// /api/notifications — the signed-in user's in-app notification feed (the bell).
//
//   GET                      → { items: [...latest 30], unread: <int> }
//   POST { all: true }       → mark all the caller's notifications read
//   POST { ids: [id, ...] }  → mark those notifications read
//   DELETE                   → clear (delete) all the caller's notifications
//   DELETE ?id=<id>          → clear that one notification
//
// Every user reads/writes only their own rows (scoped by the session email),
// so this needs auth but no special permission.
import sql from './_lib/db.js';
import { cors, requireAuth } from './_lib/middleware.js';

const FEED_LIMIT = 30;

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const payload = await requireAuth(req, res);
    if (!payload) return;
    const email = (payload.email || '').toLowerCase();

    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, notification_key, title, body, link, created_at, read_at
          FROM in_app_notifications
         WHERE user_email = ${email}
         ORDER BY created_at DESC
         LIMIT ${FEED_LIMIT}`;
      const unread = await sql`
        SELECT COUNT(*)::int AS n
          FROM in_app_notifications
         WHERE user_email = ${email} AND read_at IS NULL`;
      return res.status(200).json({
        items: rows.map(r => ({
          id: String(r.id),
          key: r.notification_key,
          title: r.title,
          body: r.body,
          link: r.link,
          createdAt: r.created_at,
          read: !!r.read_at,
        })),
        unread: unread[0]?.n || 0,
      });
    }

    if (req.method === 'POST') {
      const { ids, all } = req.body || {};
      if (all) {
        await sql`UPDATE in_app_notifications SET read_at = NOW()
                   WHERE user_email = ${email} AND read_at IS NULL`;
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
      if (Number.isFinite(id)) {
        await sql`DELETE FROM in_app_notifications WHERE user_email = ${email} AND id = ${id}`;
      } else {
        await sql`DELETE FROM in_app_notifications WHERE user_email = ${email}`;
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).end();
  } catch (err) {
    console.error('[notifications] handler error', err);
    if (!res.headersSent) return res.status(500).json({ error: err?.message || 'Server error' });
  }
}
