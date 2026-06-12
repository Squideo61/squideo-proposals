// Email open/click tracking helpers, shared by the CRM send path (and later
// the browser extension's send hook). See db/migrations/20260522_email_tracking.sql.
// The pure HTML-instrumentation helpers live in trackingHtml.js (DB-free, unit
// tested); this module adds the database-backed record/read functions.
import sql from '../db.js';

export { instrumentHtml, newTrackingToken, TRANSPARENT_GIF } from './trackingHtml.js';

// One-time self-heal: the column that gates the "first open" tracking-bell
// notification to fire once per email. Guarded so it runs at most once per warm
// instance. A matching migration also adds it for the record.
let openNotifiedColumnReady = false;
export async function ensureOpenNotifiedColumn() {
  if (openNotifiedColumnReady) return;
  await sql`ALTER TABLE email_tracking ADD COLUMN IF NOT EXISTS open_notified_at TIMESTAMPTZ`;
  openNotifiedColumnReady = true;
}

// Self-view suppression. When a team member opens one of their own tracked
// threads in Gmail, Gmail's image proxy fetches the open pixel server-side —
// indistinguishable from the recipient opening it (no session cookie, US IP).
// The browser extension, which runs inside Gmail and knows it's them, pings
// recordSelfView when they open a thread; an open that lands within the window
// afterwards is treated as that internal view, not a real recipient open.
let selfViewTableReady = false;
export async function ensureSelfViewTable() {
  if (selfViewTableReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS email_self_views (
      gmail_thread_id TEXT PRIMARY KEY,
      viewed_at TIMESTAMPTZ NOT NULL,
      viewed_by TEXT
    )`;
  selfViewTableReady = true;
}

// Record that a team member is viewing this Gmail thread right now. No-op for
// threads we aren't tracking, so the table only ever holds tracked threads.
export async function recordSelfView(gmailThreadId, viewedBy) {
  if (!gmailThreadId) return;
  try {
    await ensureSelfViewTable();
    const tracked = await sql`SELECT 1 FROM email_tracking WHERE gmail_thread_id = ${gmailThreadId} LIMIT 1`;
    if (!tracked.length) return;
    await sql`
      INSERT INTO email_self_views (gmail_thread_id, viewed_at, viewed_by)
      VALUES (${gmailThreadId}, NOW(), ${viewedBy || null})
      ON CONFLICT (gmail_thread_id)
      DO UPDATE SET viewed_at = NOW(), viewed_by = ${viewedBy || null}
    `;
  } catch (err) {
    console.error('[tracking] recordSelfView failed', err.message);
  }
}

// True if the tracked thread behind `token` was self-viewed within the window,
// so the incoming open is almost certainly that internal Gmail view (via the
// image proxy) rather than the recipient. Best-effort — false on any error.
const SELF_VIEW_WINDOW_MS = 3 * 60 * 1000;
export async function openIsInternalSelfView(token) {
  if (!token) return false;
  try {
    await ensureSelfViewTable();
    const rows = await sql`
      SELECT v.viewed_at
        FROM email_tracking t
        JOIN email_self_views v ON v.gmail_thread_id = t.gmail_thread_id
       WHERE t.token = ${token}`;
    const viewedAt = rows[0]?.viewed_at;
    if (!viewedAt) return false;
    return (Date.now() - new Date(viewedAt).getTime()) < SELF_VIEW_WINDOW_MS;
  } catch {
    return false;
  }
}

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

// Recover the Gmail thread id for a tracked send that never got one. Extension
// (Gmail-composed) sends register their tracking row BEFORE Gmail assigns ids
// and rely on a follow-up /link call to fill gmail_thread_id in; when that step
// doesn't land the row is left thread-less, so its "email opened" alert has no
// thread to deep-link to. But the sent message itself is synced into
// email_messages (via Pub/Sub) with the real thread id, so we match it back by
// recipient + subject + nearest send time. Returns the thread id or null.
export async function resolveSentThreadId({ userEmail, subject, recipients, sentAt }) {
  const recips = (recipients || []).filter(Boolean);
  if (!userEmail || !subject || !recips.length) return null;
  try {
    const rows = await sql`
      SELECT gmail_thread_id
        FROM email_messages
       WHERE user_email = ${userEmail}
         AND direction = 'outgoing'
         AND gmail_thread_id IS NOT NULL
         AND to_emails && ${recips}::text[]
         AND LOWER(subject) = LOWER(${subject})
       ORDER BY ABS(EXTRACT(EPOCH FROM (sent_at - ${sentAt || new Date()}))) ASC NULLS LAST
       LIMIT 1`;
    return rows[0]?.gmail_thread_id || null;
  } catch (err) {
    console.error('[tracking] resolveSentThreadId failed', err.message);
    return null;
  }
}

// Aggregate tracking state for a set of Gmail thread ids, for the current user.
// Opens within 5s of send are treated as Gmail's delivery-time image prefetch
// (not a real read) and excluded. Returns a map: threadId -> summary.
export async function trackingForThreads(userEmail, threadIds) {
  const ids = (threadIds || []).filter(Boolean);
  if (!ids.length) return {};
  try {
    const rows = await sql`
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
    return mapTrackingRows(rows);
  } catch (err) {
    // Table not migrated yet, etc. — tracking is additive, so degrade quietly.
    console.warn('[tracking] trackingForThreads failed', err.message);
    return {};
  }
}

// Same aggregation, but for a deal/project context: NOT scoped to one sender,
// because a deal's emails may have been sent by any team member. The threads are
// already authorised by virtue of being linked to the deal the caller can see.
export async function trackingForDealThreads(threadIds) {
  const ids = (threadIds || []).filter(Boolean);
  if (!ids.length) return {};
  try {
    const rows = await sql`
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
       WHERE t.gmail_thread_id = ANY(${ids})
       GROUP BY t.gmail_thread_id
    `;
    return mapTrackingRows(rows);
  } catch (err) {
    console.warn('[tracking] trackingForDealThreads failed', err.message);
    return {};
  }
}

function mapTrackingRows(rows) {
  const out = {};
  for (const r of rows) {
    out[r.thread_id] = {
      tracked: true,
      opens: Number(r.opens) || 0,
      lastOpenedAt: r.last_opened_at || null,
      clicks: Number(r.clicks) || 0,
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
