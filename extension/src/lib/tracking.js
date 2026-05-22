// Client-side email tracking for Gmail-composed mail. Mirrors the server's
// api/_lib/crm/trackingHtml.js: inject an open pixel + rewrite links so the
// open/click endpoints (keyed by token) can record activity. The token is
// registered with the backend separately (see content/index.jsx).

const APP_URL = process.env.SQUIDEO_API_BASE || 'https://app.squideo.com';

export function newTrackingToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const openPixel = (token) =>
  `<img src="${APP_URL}/api/track/open?t=${token}" width="1" height="1" border="0" alt="" `
  + `style="display:none!important;width:1px;height:1px;max-height:0;max-width:0;overflow:hidden;opacity:0;">`;

// Rewrite every http(s) link to route through the click endpoint and append the
// open pixel. Returns { html, links } — links[idx] is the original destination,
// resolved by the server from its own store (never the query string).
export function instrumentHtml(html, token) {
  const links = [];
  if (!html) return { html, links };
  const trackBase = `${APP_URL}/api/track/`;

  const rewritten = html.replace(
    /(href\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi,
    (match, pre, quote, url) => {
      if (url.startsWith(trackBase)) return match;
      const idx = links.length;
      links.push(url);
      return `${pre}${quote}${APP_URL}/api/track/click?t=${token}&l=${idx}${quote}`;
    },
  );

  return { html: rewritten + openPixel(token), links };
}
