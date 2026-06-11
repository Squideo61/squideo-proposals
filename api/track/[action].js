// Public, unauthenticated email-tracking endpoints. Recipients' mail clients
// hit these — no session.
//   GET /api/track/open?t=<token>             -> records an open, returns a 1x1 GIF
//   GET /api/track/click?t=<token>&l=<idx>    -> records a click, 302s to the stored URL
//
// Geo comes from Vercel's edge headers (x-vercel-ip-*), so no external lookup.
import sql from '../_lib/db.js';
import { APP_URL } from '../_lib/email.js';
import { TRANSPARENT_GIF, ensureOpenNotifiedColumn } from '../_lib/crm/tracking.js';
import { sendNotification, ensureTrackingNotificationDefaults } from '../_lib/notifications.js';

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
    const dealRows = await sql`
      SELECT deal_id FROM email_thread_deals WHERE gmail_thread_id = ${t.gmail_thread_id} LIMIT 1`;
    const dealId = dealRows[0]?.deal_id || null;
    const recipient = Array.isArray(t.recipients) && t.recipients[0] ? t.recipients[0] : 'A recipient';
    const where = geo.city || geo.country || null;
    const subject = t.subject || '(no subject)';
    // "Go to" target: the actual email thread in Gmail (works whether or not the
    // thread is linked to a deal). Falls back to the deal page if we somehow have
    // no thread id. Absolute URL — the client opens it in a new tab.
    const emailLink = t.gmail_thread_id
      ? `https://mail.google.com/mail/u/0/#all/${t.gmail_thread_id}`
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

  if (action === 'open') {
    // Always return the pixel, even on bad/missing token, so we never break
    // the rendering of the recipient's email.
    if (token) {
      try {
        await recordEvent(token, 'open', null, req);
        await notifyFirstOpen(token, viewer(req));
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
          await recordEvent(token, 'click', dest, req);
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
