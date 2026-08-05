// Marketing → Portal. Who signs up for a portal account, and whether they come
// back.
//
// This is a marketing question, not a support one, so it counts differently
// from the staff-side portal views elsewhere in the CRM:
//
//   · Marketing → Portal (here)  — how many NEW accounts, from which route,
//     and how many of them return. Date-ranged, aggregated, nobody named.
//   · Admin/contact "portal activity" — what one client did, in detail.
//
// The route split is the whole point. A crash-course signup creates its own
// account off a marketing page; an invited client is handed one by a producer
// after a deal is signed. Lumping them together would let invite volume (which
// tracks sales) masquerade as marketing performance.

import sql from '../db.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { ensurePortalTables } from '../portal/db.js';

// A day series with no gaps. Postgres only returns days that have rows, and a
// chart drawn straight off that silently closes up quiet days — which makes a
// flat week look like steady growth.
function fillDays(rows, from, to, key = 'n') {
  const byDay = new Map(rows.map((r) => [String(r.day).slice(0, 10), Number(r[key]) || 0]));
  const out = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  // Bounded independently of the loop body so a bad range can't spin forever.
  for (let i = 0; i < 400 && d <= end; i += 1) {
    const iso = d.toISOString().slice(0, 10);
    out.push({ day: iso, n: byDay.get(iso) || 0 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const isoDay = (v, fallback) => {
  const s = String(v || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : fallback;
};

// Our own accounts. Testing the portal means signing up to it, and without this
// every test lands in the figures as a course lead.
//
// Resolved to a list of ids rather than repeated as a join condition, because
// most of what's counted below (course progress, briefs, sign-ins) hangs off
// portal_user_id and never touches portal_users. One list, applied identically
// everywhere, is the only way the tiles and the chart can agree.
async function internalAccountIds() {
  const rows = await sql`
    SELECT id FROM portal_users
     WHERE COALESCE(internal, FALSE)
        OR email LIKE '%@squideo.co.uk'
        OR email LIKE '%@squideo.com'
  `.catch(() => []);
  return rows.map((r) => r.id);
}

export async function portalAnalyticsRoute(req, res, id, action, user) {
  const role = await getRole(user.role);
  if (!hasPermission(role, 'marketing.access')) {
    return res.status(403).json({ error: 'You do not have permission to view Marketing' });
  }
  if (req.method !== 'GET') return res.status(405).end();
  await ensurePortalTables();

  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const from = isoDay(req.query.from, monthAgo);
  const to = isoDay(req.query.to, today);
  // An inverted range returns nothing rather than erroring — the UI can hand
  // over a half-typed date while someone is still editing it.
  if (from > to) return res.status(200).json({ from, to, empty: true });

  // Inclusive of the whole `to` day, which is what someone picking "today"
  // means. Compared as a half-open interval so an index can still be used.
  const start = from + 'T00:00:00Z';
  const endEx = new Date(new Date(to + 'T00:00:00Z').getTime() + 86400000).toISOString();

  const skip = await internalAccountIds();

  const [
    signupRows, signupsByDay, loginRows, loginsByDay,
    activationRows, returning, totals,
  ] = await Promise.all([
    // New accounts in range, split by how they arrived. A course signup is
    // marketing's; an invite accepted is sales'. Anything else is a direct
    // sign-up we didn't attribute.
    sql`
      SELECT
        CASE
          WHEN cs.id IS NOT NULL THEN 'course'
          WHEN inv.id IS NOT NULL THEN 'invite'
          ELSE 'other'
        END AS route,
        COUNT(*)::int AS n
        FROM portal_users pu
        LEFT JOIN LATERAL (
          SELECT id FROM course_signups WHERE portal_user_id = pu.id LIMIT 1
        ) cs ON TRUE
        LEFT JOIN LATERAL (
          SELECT id FROM portal_invites
           WHERE LOWER(email) = pu.email AND accepted_at IS NOT NULL LIMIT 1
        ) inv ON TRUE
       WHERE pu.created_at >= ${start} AND pu.created_at < ${endEx}
         AND pu.id <> ALL(${skip})
       GROUP BY 1
    `.catch(() => []),
    sql`
      SELECT TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
        FROM portal_users
       WHERE created_at >= ${start} AND created_at < ${endEx}
         AND id <> ALL(${skip})
       GROUP BY 1 ORDER BY 1
    `.catch(() => []),
    // Visits. A "visit" is a sign-in: the portal keeps a session, so page views
    // would count scrolling around as returning, which it isn't.
    sql`
      SELECT COUNT(*)::int AS visits,
             COUNT(DISTINCT portal_user_id)::int AS people
        FROM portal_activity
       WHERE event_key = 'login' AND created_at >= ${start} AND created_at < ${endEx}
         AND portal_user_id <> ALL(${skip})
    `.catch(() => [{ visits: 0, people: 0 }]),
    sql`
      SELECT TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
        FROM portal_activity
       WHERE event_key = 'login' AND created_at >= ${start} AND created_at < ${endEx}
         AND portal_user_id <> ALL(${skip})
       GROUP BY 1 ORDER BY 1
    `.catch(() => []),
    // What they actually did once inside. These are the numbers that say
    // whether a signup was worth having.
    sql`
      SELECT
        (SELECT COUNT(DISTINCT portal_user_id)::int FROM course_progress
          WHERE last_viewed_at >= ${start} AND last_viewed_at < ${endEx}
            AND portal_user_id <> ALL(${skip})) AS watched_course,
        (SELECT COUNT(DISTINCT portal_user_id)::int FROM course_progress
          WHERE completed_at >= ${start} AND completed_at < ${endEx}
            AND portal_user_id <> ALL(${skip})) AS finished_a_video,
        (SELECT COUNT(*)::int FROM client_briefs
          WHERE created_at >= ${start} AND created_at < ${endEx}
            AND portal_user_id <> ALL(${skip})) AS briefs_started,
        (SELECT COUNT(*)::int FROM client_briefs
          WHERE submitted_at >= ${start} AND submitted_at < ${endEx}
            AND portal_user_id <> ALL(${skip})) AS briefs_sent,
        (SELECT COUNT(*)::int FROM quote_requests
          WHERE source = 'portal' AND created_at >= ${start} AND created_at < ${endEx}
            AND (portal_user_id IS NULL OR portal_user_id <> ALL(${skip}))) AS video_requests
    `.catch(() => []),
    // Came back on a different day. One long session isn't a return visit, so
    // this counts distinct days rather than logins.
    sql`
      SELECT COUNT(*)::int AS n FROM (
        SELECT portal_user_id
          FROM portal_activity
         WHERE event_key = 'login' AND created_at >= ${start} AND created_at < ${endEx}
         AND portal_user_id <> ALL(${skip})
         GROUP BY portal_user_id
        HAVING COUNT(DISTINCT (created_at AT TIME ZONE 'UTC')::date) > 1
      ) t
    `.catch(() => [{ n: 0 }]),
    // Standing totals, for context the range can't give: a period with two
    // signups reads differently against 20 accounts than against 2,000.
    sql`
      SELECT
        (SELECT COUNT(*)::int FROM portal_users
          WHERE disabled_at IS NULL AND id <> ALL(${skip})) AS accounts,
        (SELECT COUNT(*)::int FROM portal_users
          WHERE last_login_at IS NULL AND id <> ALL(${skip})) AS never_signed_in
    `.catch(() => []),
  ]);

  const byRoute = Object.fromEntries(signupRows.map((r) => [r.route, r.n]));
  const signups = (byRoute.course || 0) + (byRoute.invite || 0) + (byRoute.other || 0);
  const visits = loginRows[0]?.visits || 0;
  const people = loginRows[0]?.people || 0;

  return res.status(200).json({
    from,
    to,
    signups: {
      total: signups,
      course: byRoute.course || 0,
      invite: byRoute.invite || 0,
      other: byRoute.other || 0,
      byDay: fillDays(signupsByDay, from, to),
    },
    visits: {
      total: visits,
      people,
      returning: returning[0]?.n || 0,
      // Visits per person who visited — "how sticky is it", not "how busy".
      perPerson: people ? Math.round((visits / people) * 10) / 10 : 0,
      byDay: fillDays(loginsByDay, from, to),
    },
    activation: activationRows[0] || {
      watched_course: 0, finished_a_video: 0, briefs_started: 0, briefs_sent: 0, video_requests: 0,
    },
    totals: totals[0] || { accounts: 0, never_signed_in: 0 },
    // Said out loud on the page. Numbers that quietly drop rows are how a
    // report stops being trusted — and if this ever excludes a real client by
    // accident, the count is the thing that gives it away.
    excluded: skip.length,
  });
}
