import { waitUntil } from '@vercel/functions';
import sql from '../db.js';
import { ingestMessage } from '../gmailSync.js';
import { getFreshAccessToken } from './gmail.js';

// 30-day Gmail backfill. Runs in chained pages so each invocation fits inside
// the Vercel Hobby 10s timeout. The first call comes from the user (or from
// gmailCallback as fire-and-forget); subsequent pages are kicked off by this
// function itself via fetch() with a CRON_SECRET Bearer so the recursive call
// can authenticate.
//
// Caller contract:
//   POST /api/crm/gmail/backfill                            (user-authed first page)
//   POST /api/crm/gmail/backfill?userEmail=X&pageToken=Y&total=N
//     with Authorization: Bearer CRON_SECRET                (self-chained page)
//
// Idempotent: ingestMessage upserts on gmail_message_id, so retrying any page
// just no-ops the already-ingested rows.
const BACKFILL_PAGE_SIZE = 30;     // messages.get calls in parallel per page
const BACKFILL_MAX_TOTAL = 600;    // hard cap so we don't drain quota for a huge mailbox
const BACKFILL_MAX_PAGES = 30;     // belt and braces in case nextPageToken loops
const BACKFILL_BUDGET_MS = 7000;   // time budget per function call (Hobby is 10s)

export async function gmailBackfill(req, res, user) {
  const qs = (req.url || '').split('?')[1] || '';
  const params = new URLSearchParams(qs);
  const userEmail = user?.email || params.get('userEmail');
  let pageToken = params.get('pageToken') || null;
  let total = Number(params.get('total') || 0);
  let pageIndex = Number(params.get('page') || 0);

  if (!userEmail) return res.status(400).json({ error: 'userEmail required' });

  let accessToken;
  try {
    accessToken = await getFreshAccessToken(userEmail);
  } catch (err) {
    console.warn('[gmail backfill] cannot get access token', err.message);
    return res.status(200).json({ ok: false, reason: err.code || err.message });
  }

  // First call (no pageToken) — reset progress markers so a manual retry from
  // a half-done state starts cleanly.
  if (!pageToken && pageIndex === 0) {
    await sql`
      UPDATE gmail_accounts
         SET backfill_started_at = NOW(),
             backfill_completed_at = NULL,
             backfill_ingested = 0,
             updated_at = NOW()
       WHERE user_email = ${userEmail}
    `;
  }

  const startedAt = Date.now();
  let ingestedThisCall = 0;
  let failedThisCall = 0;

  // Loop pages within this function call until we hit either the time budget,
  // the message cap, or the end of the user's last-30-days mailbox. This is
  // dramatically more reliable than one-page-per-call because every chain
  // handoff is a fragile boundary; fewer handoffs, fewer points of failure.
  while (true) {
    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    listUrl.searchParams.set('q', 'newer_than:30d');
    listUrl.searchParams.set('maxResults', String(BACKFILL_PAGE_SIZE));
    if (pageToken) listUrl.searchParams.set('pageToken', pageToken);

    const listRes = await fetch(listUrl.toString(), { headers: { Authorization: 'Bearer ' + accessToken } });
    if (!listRes.ok) {
      console.error('[gmail backfill] messages.list failed', listRes.status, await listRes.text());
      return res.status(500).json({ error: 'messages.list failed' });
    }
    const listJson = await listRes.json();
    const messageIds = (listJson.messages || []).map(m => m.id);
    const nextPageToken = listJson.nextPageToken || null;

    const results = await Promise.allSettled(
      messageIds.map(id => ingestMessage({ userEmail, accessToken, messageId: id }))
    );
    const ok = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.length - ok;
    ingestedThisCall += ok;
    failedThisCall += failed;
    total += ok;
    pageIndex++;

    // Persist progress after every page so the UI's polling sees the climb.
    await sql`
      UPDATE gmail_accounts
         SET backfill_ingested = ${total},
             updated_at = NOW()
       WHERE user_email = ${userEmail}
    `;

    if (failed) {
      console.warn('[gmail backfill] some messages failed to ingest', { failed, page: pageIndex - 1 });
    }

    pageToken = nextPageToken;
    const hitCap = total >= BACKFILL_MAX_TOTAL || pageIndex >= BACKFILL_MAX_PAGES;
    const noMore = !pageToken;
    const overBudget = Date.now() - startedAt > BACKFILL_BUDGET_MS;

    if (noMore || hitCap) {
      // Done — stamp completion.
      await sql`
        UPDATE gmail_accounts
           SET backfill_completed_at = NOW(),
               updated_at = NOW()
         WHERE user_email = ${userEmail}
      `;
      return res.status(200).json({
        ok: true, completed: true,
        pagesThisCall: pageIndex,
        ingestedThisCall, failedThisCall,
        totalIngested: total,
      });
    }

    if (overBudget) {
      // Hand off to the next function invocation. waitUntil keeps Vercel
      // around long enough for the fetch to actually leave the box, which
      // plain fire-and-forget does NOT guarantee on serverless.
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const nextUrl = `${proto}://${host}/api/crm/gmail/backfill?userEmail=${encodeURIComponent(userEmail)}&pageToken=${encodeURIComponent(pageToken)}&total=${total}&page=${pageIndex}`;
      waitUntil(
        fetch(nextUrl, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + (process.env.CRON_SECRET || '') },
        }).catch(err => console.error('[gmail backfill] self-chain failed', err.message))
      );
      return res.status(200).json({
        ok: true, completed: false, chainedNext: true,
        pagesThisCall: pageIndex,
        ingestedThisCall, failedThisCall,
        totalIngested: total,
      });
    }
    // Loop continues for another page within this same invocation.
  }
}
