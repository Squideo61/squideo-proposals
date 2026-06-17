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

// One open notification per thread per window. Opening a thread in any mail
// client fetches the pixel for EVERY tracked message in it at once, so without
// this a multi-send thread fires a burst of "opened" alerts. Atomic per
// (user, thread) so concurrent pixel loads can't all claim — exactly one wins.
// Returns true if the caller should send the notification. Best-effort: on any
// error (or no thread id) it returns true so we never silently drop alerts.
let threadNotifyTableReady = false;
export async function claimThreadOpenNotify(userEmail, gmailThreadId) {
  if (!userEmail || !gmailThreadId) return true;
  try {
    if (!threadNotifyTableReady) {
      await sql`
        CREATE TABLE IF NOT EXISTS email_thread_open_notify (
          user_email TEXT NOT NULL,
          gmail_thread_id TEXT NOT NULL,
          notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_email, gmail_thread_id)
        )`;
      threadNotifyTableReady = true;
    }
    // Insert (first ever) or refresh only if the last alert is older than the
    // window. A row returned means we won the claim → notify; empty means a
    // sibling open just notified → skip.
    const won = await sql`
      INSERT INTO email_thread_open_notify (user_email, gmail_thread_id, notified_at)
      VALUES (${userEmail}, ${gmailThreadId}, NOW())
      ON CONFLICT (user_email, gmail_thread_id)
      DO UPDATE SET notified_at = NOW()
        WHERE email_thread_open_notify.notified_at < NOW() - interval '10 minutes'
      RETURNING gmail_thread_id`;
    return won.length > 0;
  } catch (err) {
    console.error('[tracking] claimThreadOpenNotify failed', err.message);
    return true;
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
  // Lowercase the recipients: gmail_sync stores addresses with original casing
  // and array overlap is case-sensitive, so match on LOWER() of each.
  const recips = (recipients || []).filter(Boolean).map((r) => String(r).toLowerCase());
  if (!userEmail || !recips.length) return null;
  const when = sentAt ? new Date(sentAt) : new Date();
  try {
    const rows = await sql`
      SELECT gmail_thread_id
        FROM email_messages
       WHERE LOWER(user_email) = LOWER(${userEmail})
         -- two send conventions live here: 'outgoing' (CRM composer) and
         -- 'outbound' (Pub/Sub sync of Gmail-composed mail).
         AND direction IN ('outgoing', 'outbound')
         AND gmail_thread_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM unnest(to_emails) AS e WHERE LOWER(e) = ANY(${recips}::text[]))
         -- the tracked send and its synced copy are the same email (≈ same
         -- instant); a day's window safely excludes unrelated mail to the same
         -- recipient while tolerating clock/header skew.
         AND ABS(EXTRACT(EPOCH FROM (sent_at - ${when}))) < 86400
       ORDER BY (LOWER(COALESCE(subject, '')) = LOWER(${subject || ''})) DESC,
                ABS(EXTRACT(EPOCH FROM (sent_at - ${when}))) ASC
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
             (ARRAY_REMOVE(ARRAY_AGG(e.city ORDER BY e.occurred_at DESC)
               FILTER (WHERE e.kind = 'open' AND e.occurred_at > t.sent_at + interval '5 seconds'), NULL))[1] AS last_city,
             (ARRAY_REMOVE(ARRAY_AGG(e.country ORDER BY e.occurred_at DESC)
               FILTER (WHERE e.kind = 'open' AND e.occurred_at > t.sent_at + interval '5 seconds'), NULL))[1] AS last_country,
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
             (ARRAY_REMOVE(ARRAY_AGG(e.city ORDER BY e.occurred_at DESC)
               FILTER (WHERE e.kind = 'open' AND e.occurred_at > t.sent_at + interval '5 seconds'), NULL))[1] AS last_city,
             (ARRAY_REMOVE(ARRAY_AGG(e.country ORDER BY e.occurred_at DESC)
               FILTER (WHERE e.kind = 'open' AND e.occurred_at > t.sent_at + interval '5 seconds'), NULL))[1] AS last_country,
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

// Per-MESSAGE tracking, keyed by gmail_message_id — drives the eye on each sent
// email row and the "last email" banner (the latest sent email's own state,
// not a thread-wide sum). Same aggregation as trackingForThreads but grouped by
// message. Not scoped to a sender: gmail_message_id is unique and the thread is
// already authorised by the caller.
export async function trackingForMessages(messageIds) {
  const ids = (messageIds || []).filter(Boolean);
  if (!ids.length) return {};
  try {
    const rows = await sql`
      SELECT t.gmail_message_id AS message_id,
             COUNT(*) FILTER (WHERE e.kind = 'open'
               AND e.occurred_at > t.sent_at + interval '5 seconds')                       AS opens,
             MAX(e.occurred_at) FILTER (WHERE e.kind = 'open'
               AND e.occurred_at > t.sent_at + interval '5 seconds')                       AS last_opened_at,
             COUNT(*) FILTER (WHERE e.kind = 'click')                                       AS clicks,
             MAX(e.occurred_at) FILTER (WHERE e.kind = 'click')                             AS last_clicked_at,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT e.city) FILTER (WHERE e.kind = 'open'), NULL)  AS cities,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT e.country) FILTER (WHERE e.kind = 'open'), NULL) AS countries,
             (ARRAY_REMOVE(ARRAY_AGG(e.city ORDER BY e.occurred_at DESC)
               FILTER (WHERE e.kind = 'open' AND e.occurred_at > t.sent_at + interval '5 seconds'), NULL))[1] AS last_city,
             (ARRAY_REMOVE(ARRAY_AGG(e.country ORDER BY e.occurred_at DESC)
               FILTER (WHERE e.kind = 'open' AND e.occurred_at > t.sent_at + interval '5 seconds'), NULL))[1] AS last_country,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT e.link_url) FILTER (WHERE e.kind = 'click'), NULL) AS clicked_urls
        FROM email_tracking t
        LEFT JOIN email_tracking_events e ON e.tracking_id = t.id
       WHERE t.gmail_message_id = ANY(${ids})
       GROUP BY t.gmail_message_id
    `;
    const out = {};
    for (const r of rows) {
      out[r.message_id] = {
        tracked: true,
        opens: Number(r.opens) || 0,
        lastOpenedAt: r.last_opened_at || null,
        clicks: Number(r.clicks) || 0,
        lastClickedAt: r.last_clicked_at || null,
        locations: buildLocations(r.cities, r.countries),
        lastLocation: r.last_city || r.last_country || null,
        clickedUrls: r.clicked_urls || [],
      };
    }
    return out;
  } catch (err) {
    console.warn('[tracking] trackingForMessages failed', err.message);
    return {};
  }
}

// Self-heal: link orphaned tracking rows to a deal's emails. Extension-composed
// (Gmail) sends register their tracking row at 'presending' with NULL ids and
// rely on a follow-up /link call to fill the Gmail ids; when that step doesn't
// land (e.g. an out-of-date extension build) the row is left with BOTH
// gmail_thread_id AND gmail_message_id null — so neither trackingForDealThreads
// (by thread) nor trackingForMessages (by message) can find it, and a
// teammate's tracked email shows no eye at all. We recover the link the same
// way resolveSentThreadId does in reverse: match each orphan to the deal's
// synced sent message by shared recipient + nearest send time (subject
// preferred), then patch its ids. Runs on deal load; once patched, subsequent
// loads find no orphans and skip. Best-effort — never throws.
export async function backfillDealTrackingIds(emails) {
  const outbound = (emails || []).filter((e) =>
    e.gmail_thread_id && e.gmail_message_id &&
    (e.direction === 'outgoing' || e.direction === 'outbound'));
  if (!outbound.length) return;
  const recips = Array.from(new Set(
    outbound.flatMap((e) => (e.to_emails || []).map((x) => String(x).toLowerCase()))
  )).filter(Boolean);
  if (!recips.length) return;
  try {
    const orphans = await sql`
      SELECT id, recipients, subject, sent_at
        FROM email_tracking
       WHERE gmail_thread_id IS NULL
         AND EXISTS (SELECT 1 FROM unnest(recipients) r WHERE LOWER(r) = ANY(${recips}::text[]))`;
    if (!orphans.length) return;
    const norm = (s) => String(s || '').replace(/^\s*re:\s*/i, '').trim().toLowerCase();
    const WINDOW_MS = 10 * 60 * 1000;
    // Greedy one-to-one: oldest orphan first, each claims the closest unused
    // outbound message, so a multi-send thread maps row↔message rather than
    // collapsing several rows onto one email.
    const used = new Set();
    const ordered = [...orphans].sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));
    for (const o of ordered) {
      const oRecips = (o.recipients || []).map((x) => String(x).toLowerCase());
      let best = null, bestScore = Infinity;
      for (const e of outbound) {
        if (used.has(e.gmail_message_id)) continue;
        const eRecips = (e.to_emails || []).map((x) => String(x).toLowerCase());
        if (!eRecips.some((x) => oRecips.includes(x))) continue;
        const dt = Math.abs(new Date(e.sent_at).getTime() - new Date(o.sent_at).getTime());
        if (dt > WINDOW_MS) continue;
        const score = dt + (norm(e.subject) === norm(o.subject) ? 0 : 5 * 60 * 1000);
        if (score < bestScore) { bestScore = score; best = e; }
      }
      if (best) {
        used.add(best.gmail_message_id);
        await sql`
          UPDATE email_tracking
             SET gmail_message_id = COALESCE(gmail_message_id, ${best.gmail_message_id}),
                 gmail_thread_id  = ${best.gmail_thread_id}
           WHERE id = ${o.id} AND gmail_thread_id IS NULL`;
      }
    }
  } catch (err) {
    console.warn('[tracking] backfillDealTrackingIds failed', err.message);
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
      // The location of the single most recent open — surfaced/highlighted in
      // the UI separately from the distinct set, so "where they last read it"
      // is clear even when the email's been opened from several places.
      lastLocation: r.last_city || r.last_country || null,
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
