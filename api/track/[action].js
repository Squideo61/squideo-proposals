// Public, unauthenticated email-tracking endpoints. Recipients' mail clients
// hit these — no session.
//   GET /api/track/open?t=<token>             -> records an open, returns a 1x1 GIF
//   GET /api/track/click?t=<token>&l=<idx>    -> records a click, 302s to the stored URL
//
// Geo comes from Vercel's edge headers (x-vercel-ip-*), so no external lookup.
import sql from '../_lib/db.js';
import { APP_URL } from '../_lib/email.js';
import { TRANSPARENT_GIF, ensureOpenNotifiedColumn, openIsInternalSelfView, resolveSentThreadId } from '../_lib/crm/tracking.js';
import { sendNotification, ensureTrackingNotificationDefaults } from '../_lib/notifications.js';
import { optionalAuth } from '../_lib/middleware.js';

function viewer(req) {
  const h = req.headers;
  const ip = (h['x-forwarded-for'] || '').split(',')[0].trim() || h['x-real-ip'] || null;
  const country = h['x-vercel-ip-country'] || null;
  const region = h['x-vercel-ip-country-region'] || null;
  let city = h['x-vercel-ip-city'] || null;
  if (city) { try { city = decodeURIComponent(city); } catch { /* keep raw */ } }
  return { ip, country, region, city, ua: h['user-agent'] || null };
}

async function recordEvent(token, kind, linkUrl, req) {
  const rows = await sql`SELECT id FROM email_tracking WHERE token = ${token}`;
  const trackingId = rows[0]?.id;
  if (!trackingId) return;
  const v = viewer(req);
  await sql`
    INSERT INTO email_tracking_events
      (tracking_id, kind, occurred_at, ip_address, country, region, city, user_agent, link_url)
    VALUES
      (${trackingId}, ${kind}, NOW(), ${v.ip}, ${v.country}, ${v.region}, ${v.city}, ${v.ua}, ${linkUrl || null})
  `;
}

// Fire the owner's "email opened" tracking-bell alert the first time a real
// open lands. Opens within 5s of send are Gmail's delivery-time image prefetch,
// not a human read, so they don't count. open_notified_at is claimed race-safely
// so concurrent opens only notify once. Best-effort — never throws to the pixel.
const OPEN_PREFETCH_MS = 5000;
async function notifyFirstOpen(token, geo) {
  try {
    await ensureOpenNotifiedColumn();
    const rows = await sql`
      SELECT id, user_email, subject, gmail_thread_id, recipients, sent_at, open_notified_at
        FROM email_tracking WHERE token = ${token}`;
    const t = rows[0];
    if (!t || !t.user_email || t.open_notified_at) return;
    // Skip the delivery-time prefetch; a later genuine open will notify.
    if (Date.now() < new Date(t.sent_at).getTime() + OPEN_PREFETCH_MS) return;

    // Race-safe claim: only the first qualifying open flips the flag.
    const claim = await sql`
      UPDATE email_tracking SET open_notified_at = NOW()
       WHERE token = ${token} AND open_notified_at IS NULL
       RETURNING id`;
    if (!claim.length) return;

    await ensureTrackingNotificationDefaults();
    // Extension-composed sends can lack a thread id (the /link step didn't land);
    // recover it from the synced sent message so the alert is still deep-linkable,
    // and heal the tracking row so the CRM inbox eye attaches too.
    let threadId = t.gmail_thread_id;
    if (!threadId) {
      threadId = await resolveSentThreadId({ userEmail: t.user_email, subject: t.subject, recipients: t.recipients, sentAt: t.sent_at });
      if (threadId) {
        try { await sql`UPDATE email_tracking SET gmail_thread_id = ${threadId} WHERE token = ${token} AND gmail_thread_id IS NULL`; }
        catch { /* best-effort heal */ }
      }
    }
    const dealRows = threadId
      ? await sql`SELECT deal_id FROM email_thread_deals WHERE gmail_thread_id = ${threadId} LIMIT 1`
      : [];
    const dealId = dealRows[0]?.deal_id || null;
    const recipient = Array.isArray(t.recipients) && t.recipients[0] ? t.recipients[0] : 'A recipient';
    const where = geo.city || geo.country || null;
    const subject = t.subject || '(no subject)';
    // "Go to" target: open the email thread inside the CRM's own Emails view
    // (works whether or not the thread is linked to a deal). Falls back to the
    // deal page only if we somehow have no thread id.
    const emailLink = threadId
      ? `#/email/${encodeURIComponent(threadId)}`
      : (dealId ? `#/deal/${dealId}` : null);
    await sendNotification('tracking.email_opened', {
      ownerEmail: t.user_email,
      inAppOnly: true,
      subject: `Email opened: ${subject}`,
      inApp: {
        title: `Email opened: ${subject}`,
        body: `${recipient} just opened it${where ? ' · ' + where : ''}`,
        link: emailLink,
        tag: `email-open-${t.id}`,
      },
    });
  } catch (err) {
    console.error('[track] notifyFirstOpen failed', err.message);
  }
}

export default async function handler(req, res) {
  const action = req.query.action;
  const token = typeof req.query.t === 'string' ? req.query.t : null;

  // A logged-in team member viewing the email inside the CRM (e.g. their own
  // Sent copy, or any thread in the Emails view) loads the pixel/links from the
  // same origin, so their session cookie rides along. Recognise that and skip
  // recording — only genuine recipients (no session) should register opens and
  // clicks. Mirrors the self-view guard on public proposal tracking.
  const internalViewer = await optionalAuth(req).catch(() => null);

  if (action === 'open') {
    // Skip opens fired by a team member reading their own tracked thread in
    // Gmail (the extension flags it via /tracking/self-view); Gmail's image
    // proxy otherwise makes those look like a genuine recipient open. The pixel
    // is invisible, so we can afford a short grace delay first — that lets the
    // extension's self-view ping win the race even when Gmail fetches the pixel
    // a beat before the ping lands.
    if (token && !internalViewer) {
      try {
        await new Promise((r) => setTimeout(r, 2000));
        if (!(await openIsInternalSelfView(token).catch(() => false))) {
          await recordEvent(token, 'open', null, req);
          await notifyFirstOpen(token, viewer(req));
        }
      }
      catch (err) { console.error('[track] open failed', err.message); }
    }
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).send(TRANSPARENT_GIF);
  }

  if (action === 'click') {
    const idx = Number.parseInt(req.query.l, 10);
    let dest = APP_URL;
    if (token && Number.isInteger(idx)) {
      try {
        const rows = await sql`
          SELECT l.url
            FROM email_tracking_links l
            JOIN email_tracking t ON t.id = l.tracking_id
           WHERE t.token = ${token} AND l.idx = ${idx}
        `;
        if (rows[0]?.url) {
          dest = rows[0].url;
          // Still redirect internal viewers to the real link, just don't log it.
          if (!internalViewer) await recordEvent(token, 'click', dest, req);
        }
      } catch (err) {
        console.error('[track] click failed', err.message);
      }
    }
    res.setHeader('Cache-Control', 'no-store, private');
    res.writeHead(302, { Location: dest });
    return res.end();
  }

  return res.status(404).json({ error: 'Unknown tracking action' });
}
