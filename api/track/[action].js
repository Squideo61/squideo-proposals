// Public, unauthenticated email-tracking endpoints. Recipients' mail clients
// hit these — no session.
//   GET /api/track/open?t=<token>             -> records an open, returns a 1x1 GIF
//   GET /api/track/click?t=<token>&l=<idx>    -> records a click, 302s to the stored URL
//
// Geo comes from Vercel's edge headers (x-vercel-ip-*), so no external lookup.
import sql from '../_lib/db.js';
import { APP_URL } from '../_lib/email.js';
import { TRANSPARENT_GIF } from '../_lib/crm/tracking.js';

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

export default async function handler(req, res) {
  const action = req.query.action;
  const token = typeof req.query.t === 'string' ? req.query.t : null;

  if (action === 'open') {
    // Always return the pixel, even on bad/missing token, so we never break
    // the rendering of the recipient's email.
    if (token) {
      try { await recordEvent(token, 'open', null, req); }
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
