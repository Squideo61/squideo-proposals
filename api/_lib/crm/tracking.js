// Email open/click tracking helpers, shared by the CRM send path (and later
// the browser extension's send hook). See db/migrations/20260522_email_tracking.sql.
// The pure HTML-instrumentation helpers live in trackingHtml.js (DB-free, unit
// tested); this module adds the database-backed record/read functions.
import sql from '../db.js';

export { instrumentHtml, newTrackingToken, TRANSPARENT_GIF } from './trackingHtml.js';

// Persist a tracking row + its rewritten links after a successful send. Never
// throws — tracking is best-effort and must not fail the send.
export async function recordTrackedSend({ token, userEmail, messageId, threadId, subject, recipients, links, source = 'crm' }) {
  try {
    const inserted = await sql`
      INSERT INTO email_tracking (token, user_email, gmail_message_id, gmail_thread_id, subject, recipients, source)
      VALUES (${token}, ${userEmail}, ${messageId || null}, ${threadId || null}, ${subject || null},
              ${recipients || []}, ${source})
      ON CONFLICT (token) DO NOTHING
      RETURNING id
    `;
    const trackingId = inserted[0]?.id;
    if (trackingId && links && links.length) {
      for (let i = 0; i < links.length; i++) {
        await sql`
          INSERT INTO email_tracking_links (tracking_id, idx, url)
          VALUES (${trackingId}, ${i}, ${links[i]})
          ON CONFLICT (tracking_id, idx) DO NOTHING
        `;
      }
    }
    return trackingId || null;
  } catch (err) {
    console.error('[tracking] recordTrackedSend failed', err.message);
    return null;
  }
}

// Aggregate tracking state for a set of Gmail thread ids, for the current user.
// Opens within 5s of send are treated as Gmail's delivery-time image prefetch
// (not a real read) and excluded. Returns a map: threadId -> summary.
export async function trackingForThreads(userEmail, threadIds) {
  const ids = (threadIds || []).filter(Boolean);
  if (!ids.length) return {};
  let rows;
  try {
    rows = await sql`
      SELECT t.gmail_thread_id AS thread_id,
             COUNT(*) FILTER (WHERE e.kind = 'open'
               AND e.occurred_at > t.sent_at + interval '5 seconds')                       AS opens,
             MAX(e.occurred_at) FILTER (WHERE e.kind = 'open'
               AND e.occurred_at > t.sent_at + interval '5 seconds')                       AS last_opened_at,
             COUNT(*) FILTER (WHERE e.kind = 'click')                                       AS clicks,
             MAX(e.occurred_at) FILTER (WHERE e.kind = 'click')                             AS last_clicked_at,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT e.city) FILTER (WHERE e.kind = 'open'), NULL)  AS cities,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT e.country) FILTER (WHERE e.kind = 'open'), NULL) AS countries,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT e.link_url) FILTER (WHERE e.kind = 'click'), NULL) AS clicked_urls
        FROM email_tracking t
        LEFT JOIN email_tracking_events e ON e.tracking_id = t.id
       WHERE t.user_email = ${userEmail}
         AND t.gmail_thread_id = ANY(${ids})
       GROUP BY t.gmail_thread_id
    `;
  } catch (err) {
    // Table not migrated yet, etc. — tracking is additive, so degrade quietly.
    console.warn('[tracking] trackingForThreads failed', err.message);
    return {};
  }

  const out = {};
  for (const r of rows) {
    const opens = Number(r.opens) || 0;
    const clicks = Number(r.clicks) || 0;
    out[r.thread_id] = {
      tracked: true,
      opens,
      lastOpenedAt: r.last_opened_at || null,
      clicks,
      lastClickedAt: r.last_clicked_at || null,
      locations: buildLocations(r.cities, r.countries),
      clickedUrls: r.clicked_urls || [],
    };
  }
  return out;
}

function buildLocations(cities, countries) {
  const out = [];
  for (const c of cities || []) if (c) out.push(c);
  if (!out.length) for (const c of countries || []) if (c) out.push(c);
  return out;
}
