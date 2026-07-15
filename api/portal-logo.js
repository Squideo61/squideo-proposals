// Serves a client's own logo as image bytes: the portal header, the portal
// sign-in screens and the portal emails all point an <img src> here.
//
// Public by necessity — an email client fetches it with no cookies, and it has
// to work on the sign-in screen before there is a session. What it discloses is
// the customer's own brand mark, keyed by an unguessable company id.

import { companyLogoDataUrl, decodeLogo } from './_lib/portal/logo.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const companyId = req.query.c ? String(req.query.c) : '';
  if (!companyId) return res.status(400).send('missing company');

  let logo;
  try {
    logo = decodeLogo(await companyLogoDataUrl(companyId));
  } catch (err) {
    console.error('[portal-logo] lookup failed', err);
    return res.status(500).send('lookup failed');
  }
  if (!logo) return res.status(404).send('no logo');

  res.setHeader('Content-Type', logo.contentType);
  res.setHeader('Content-Length', String(logo.bytes.length));
  res.setHeader('Cache-Control', 'public, max-age=3600');
  // A client logo can be an SVG, which is script-capable — served from our own
  // origin that would be an XSS vector if opened directly. Same lockdown as the
  // email-image proxy: no scripts, no sniffing, no ambient authority.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Disposition', 'inline');
  return res.status(200).end(logo.bytes);
}
