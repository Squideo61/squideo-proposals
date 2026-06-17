// /api/tracking-cleanup — one-off maintenance. The email-image proxy briefly
// fetched our own open-pixel server-side (a regression, now fixed), which
// recorded the team's own CRM views as recipient opens. Those events carry the
// proxy's distinctive User-Agent — no genuine recipient open ever does — so we
// can identify and remove them safely.
//
// GET (settings.manage — i.e. admins):
//   (no param)  -> dry run: { wouldDelete }
//   ?confirm=1  -> deletes them + re-arms the first-open alert for any email
//                  left with zero opens, returns { deleted, reArmed }
import sql from './_lib/db.js';
import { cors, requirePermission } from './_lib/middleware.js';

const PROXY_UA = 'SquideoMailImageProxy/1.0';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const auth = await requirePermission(req, res, 'settings.manage');
  if (!auth) return;

  try {
    if (req.query?.confirm !== '1') {
      const [{ count }] = await sql`
        SELECT COUNT(*)::int AS count FROM email_tracking_events WHERE user_agent = ${PROXY_UA}`;
      return res.status(200).json({ wouldDelete: count, hint: 'Re-run with ?confirm=1 to delete.' });
    }

    const deleted = await sql`
      DELETE FROM email_tracking_events WHERE user_agent = ${PROXY_UA} RETURNING id`;

    // An email whose only "open" was a deleted false one is genuinely unopened
    // again — clear its open_notified_at so a real first open still alerts.
    // Emails with a remaining real open keep their flag (no duplicate alert).
    const reArmed = await sql`
      UPDATE email_tracking SET open_notified_at = NULL
       WHERE open_notified_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM email_tracking_events e
            WHERE e.tracking_id = email_tracking.id AND e.kind = 'open')
      RETURNING id`;

    return res.status(200).json({ deleted: deleted.length, reArmed: reArmed.length });
  } catch (err) {
    console.error('[tracking-cleanup]', err);
    return res.status(500).json({ error: err?.message || 'cleanup failed' });
  }
}
