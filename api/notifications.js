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
import { channelForKey, FINANCE_CHANNEL_KEYS, TRACKING_CHANNEL_KEYS, BELL_HIDDEN_KEYS } from './_lib/notificationsCatalog.js';
import { resolveSentThreadId } from './_lib/crm/tracking.js';

const FEED_LIMIT = 30;

// Repair `tracking.email_opened` alerts persisted with link = NULL — either
// created before the clickable link shipped (06-11), or whose tracking row never
// got a thread id (extension sends whose /link step didn't land). The alert's
// created_at is essentially simultaneous with the email_tracking row's
// open_notified_at (both written inside notifyFirstOpen), so we match each alert
// to its tracking row by nearest timestamp, then take the thread id directly or
// recover it from the synced sent message (resolveSentThreadId). Truly
// unrecoverable alerts fall back to the Sent folder so they stop re-triggering
// this pass. Scoped to one user; self-heals the backlog then no-ops.
// Returns a Map of notificationId -> new link for the rows it fixed.
async function backfillEmailOpenLinks(email) {
  const fixed = new Map();
  try {
    // Pick up never-linked alerts, ones earlier passes parked on the Sent-folder
    // fallback, and legacy `#/email/<thread>` links (which navigated into the full
    // thread) so they all upgrade to the focused `#/email-open/<thread>` modal.
    const notifs = await sql`
      SELECT id, created_at, link FROM in_app_notifications
       WHERE user_email = ${email} AND notification_key = 'tracking.email_opened'
         AND (link IS NULL OR link = '#/emails/sent' OR link LIKE '#/email/%')`;
    if (!notifs.length) return fixed;
    const tracks = await sql`
      SELECT subject, recipients, sent_at, open_notified_at, gmail_thread_id
        FROM email_tracking
       WHERE user_email = ${email} AND open_notified_at IS NOT NULL`;
    for (const n of notifs) {
      let link;
      const legacy = typeof n.link === 'string' && n.link.startsWith('#/email/');
      if (legacy) {
        // Already had a thread — just point it at the tracking modal instead.
        link = '#/email-open/' + n.link.slice('#/email/'.length);
      } else {
        // Nearest tracking row by open-notify time (≈ the alert's created_at).
        let best = null, bestDiff = Infinity;
        for (const tr of tracks) {
          const diff = Math.abs(new Date(n.created_at) - new Date(tr.open_notified_at));
          if (diff < bestDiff) { bestDiff = diff; best = tr; }
        }
        if (!best || bestDiff > 120000) continue; // no confident match — leave for now
        const threadId = best.gmail_thread_id
          || await resolveSentThreadId({ userEmail: email, subject: best.subject, recipients: best.recipients, sentAt: best.sent_at });
        if (threadId) {
          link = '#/email-open/' + encodeURIComponent(threadId);
        } else if (Date.now() - new Date(n.created_at).getTime() > 86400000) {
          // Old and still unresolvable (the sent copy never synced) — settle on the
          // Sent folder so it stops re-triggering this pass on every poll.
          link = '#/emails/sent';
        } else {
          continue; // recent: give Gmail sync time to land, retry next poll
        }
      }
      await sql`UPDATE in_app_notifications SET link = ${link}
                 WHERE id = ${n.id} AND (link IS NULL OR link = '#/emails/sent' OR link LIKE '#/email/%')`;
      fixed.set(String(n.id), link);
    }
  } catch {
    // email_tracking / email_messages may not exist on a fresh workspace.
  }
  return fixed;
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
             AND NOT (notification_key = ANY(${BELL_HIDDEN_KEYS}))
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
             AND NOT (notification_key = ANY(${TRACKING_CHANNEL_KEYS}))
             AND NOT (notification_key = ANY(${BELL_HIDDEN_KEYS}))`,
      ]);

      const tracking = { items: trackingRows.map(mapRow), unread: trackingUnread[0]?.n || 0 };
      // Repair any pre-link email-open alerts still in the feed (no-op once the
      // backlog is healed), then patch the fixed links into this response so the
      // user can click straight through without waiting for the next poll.
      if (tracking.items.some((it) => it.key === 'tracking.email_opened'
        && (!it.link || it.link === '#/emails/sent' || it.link.startsWith('#/email/')))) {
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
