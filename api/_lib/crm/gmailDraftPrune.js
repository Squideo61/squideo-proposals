// Remove Gmail DRAFTS that were filed as sent mail before ingestMessage
// learned to refuse them.
//
// A draft is a real message inside its Gmail thread, and Gmail writes a NEW one
// on every autosave while you type, deleting the one before it. history.list
// reported each of those as `messagesAdded`, so the CRM snapshotted every
// pause-while-typing version of an email and showed them all as "OUT". One deal
// thread carried four of them above the one message the client actually
// received, which read as four emails to the client rather than one.
// gmailSync.js now drops drafts on the way in; this is for what is already
// stored.
//
// ── HOW A STORED DRAFT IS IDENTIFIED ────────────────────────────────────────
// Not by guessing from the body. One threads.get returns every message Gmail
// currently holds for a thread, with its labels, in a single call — so one
// request settles a whole conversation. Against that list a stored row is a
// draft when either:
//
//   * Gmail reports its id WITH the DRAFT label — a draft still being written.
//   * Gmail does not report its id at all — an autosave Gmail deleted when the
//     next one replaced it, or when the message was finally sent. Nearly all of
//     them look like this, since only the newest autosave ever exists.
//
// ── GUARDS, BECAUSE THIS DELETES ROWS ───────────────────────────────────────
//   * OUTBOUND only. A received email is never a draft, so no amount of odd
//     behaviour from the thread lookup can touch inbound mail.
//   * The lookup must succeed AND come back with at least one message. A 404, a
//     revoked token or an empty reply skips the thread — "we learned nothing"
//     must never be read as "every row in here is stale".
//   * `:panel-stub` ids are the CRM's own placeholder rows, not Gmail messages.
//   * Reports only, unless called with apply: true.

import sql from '../db.js';
import { getFreshAccessToken } from './gmail.js';

const DEFAULT_THREADS = 150;
const MAX_THREADS = 500;
// Leaves room inside the function budget for the per-thread Gmail calls.
const TIME_BUDGET_MS = 45_000;

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

// POST /api/crm/gmail/prune-drafts
//   { apply?: boolean, days?: number, limit?: number }
// Returns what it found (and removed, with apply) plus whether the window holds
// more threads than this run could check, so it can be called again.
export async function gmailPruneDrafts(req, res, user) {
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};
  const apply = body.apply === true;
  const days = Math.min(3650, Math.max(1, num(body.days, 90)));
  const limit = Math.min(MAX_THREADS, Math.max(1, num(body.limit, DEFAULT_THREADS)));

  // Threads worth a lookup: active inside the window and holding at least one
  // outbound message we could have mis-filed. Newest first, so repeated runs
  // work backwards and the conversations people are actually reading are
  // cleaned first.
  const threads = await sql`
    SELECT et.gmail_thread_id, et.user_email
    FROM email_threads et
    WHERE et.last_message_at > NOW() - (${String(days)} || ' days')::interval
      AND EXISTS (
        SELECT 1 FROM email_messages em
        WHERE em.gmail_thread_id = et.gmail_thread_id
          AND em.direction = 'outbound'
          AND em.gmail_message_id NOT LIKE '%-stub'
      )
    ORDER BY et.last_message_at DESC
    LIMIT ${limit}
  `;

  // One token per mailbox, not per thread.
  const tokens = new Map();
  const tokenFor = async (email) => {
    if (!tokens.has(email)) {
      try {
        tokens.set(email, await getFreshAccessToken(email));
      } catch (err) {
        console.warn('[gmail prune-drafts] no token', email, err.message);
        tokens.set(email, null);
      }
    }
    return tokens.get(email);
  };

  const startedAt = Date.now();
  const found = [];
  let checked = 0;
  let skipped = 0;
  let removed = 0;
  let ranOut = false;

  for (const t of threads) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { ranOut = true; break; }

    const token = await tokenFor(t.user_email);
    if (!token) { skipped++; continue; }

    const url = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(t.gmail_thread_id)}`,
    );
    url.searchParams.set('format', 'minimal');
    url.searchParams.set('fields', 'messages(id,labelIds)');

    let live = null;
    try {
      const r = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) { skipped++; continue; }
      live = (await r.json()).messages || [];
    } catch (err) {
      console.warn('[gmail prune-drafts] threads.get failed', t.gmail_thread_id, err.message);
      skipped++;
      continue;
    }
    if (!live.length) { skipped++; continue; }
    checked++;

    const sentIds = new Set();
    const draftIds = new Set();
    for (const m of live) {
      if (!m?.id) continue;
      ((m.labelIds || []).includes('DRAFT') ? draftIds : sentIds).add(m.id);
    }

    const stored = await sql`
      SELECT gmail_message_id, subject, sent_at
      FROM email_messages
      WHERE gmail_thread_id = ${t.gmail_thread_id}
        AND direction = 'outbound'
        AND gmail_message_id NOT LIKE '%-stub'
    `;

    const stale = stored.filter(
      (s) => draftIds.has(s.gmail_message_id) || !sentIds.has(s.gmail_message_id),
    );
    if (!stale.length) continue;

    for (const s of stale) {
      found.push({
        gmailThreadId: t.gmail_thread_id,
        gmailMessageId: s.gmail_message_id,
        subject: s.subject || null,
        sentAt: s.sent_at,
        reason: draftIds.has(s.gmail_message_id) ? 'labelled DRAFT' : 'not in the Gmail thread',
      });
    }

    if (apply) {
      // One statement per thread rather than per message; email_message_deals
      // cascades from the message row.
      const ids = stale.map((s) => s.gmail_message_id);
      await sql`DELETE FROM email_messages WHERE gmail_message_id = ANY(${ids})`;
      removed += ids.length;
    }
  }

  console.log('[gmail prune-drafts]', {
    by: user.email, apply, days, checked, skipped, found: found.length, removed,
  });

  return res.status(200).json({
    apply,
    days,
    threadsConsidered: threads.length,
    threadsChecked: checked,
    threadsSkipped: skipped,
    draftsFound: found.length,
    draftsRemoved: removed,
    // Enough to eyeball before committing to a run with apply.
    sample: found.slice(0, 50),
    // True when the window still holds threads this run didn't reach.
    more: ranOut || threads.length === limit,
  });
}
