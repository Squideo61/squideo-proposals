// Pure (no-DB) email-tracking helpers: token generation, the open pixel, and
// link rewriting. Kept separate from tracking.js so it can be unit-tested
// without pulling in the database client.
import crypto from 'crypto';

// APP_URL is duplicated here (rather than imported from email.js) so this
// module stays free of the DB import chain. Keep in sync with email.js.
const APP_URL = process.env.APP_URL || 'https://app.squideo.com';

// 1x1 fully-transparent GIF — the body the open-pixel endpoint returns.
export const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

export const newTrackingToken = () => crypto.randomBytes(16).toString('hex');

const OPEN_PIXEL = (token) =>
  `<img src="${APP_URL}/api/track/open?t=${token}" width="1" height="1" border="0" alt="" `
  + `style="display:none!important;width:1px;height:1px;max-height:0;max-width:0;overflow:hidden;opacity:0;">`;

// Rewrite every http(s) link in `html` to route through the click endpoint and
// append the open pixel. Returns the instrumented html plus the ordered list of
// original URLs (their array index is the `l` param on the click URL, so the
// endpoint resolves the destination from our own DB — never from the query
// string). Anchors, mailto:/tel: and already-tracked links are left alone.
export function instrumentHtml(html, token) {
  const links = [];
  if (!html) return { html, links };
  const trackBase = `${APP_URL}/api/track/`;

  const rewritten = html.replace(
    /(href\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi,
    (match, pre, quote, url) => {
      if (url.startsWith(trackBase)) return match; // don't double-wrap
      const idx = links.length;
      links.push(url);
      return `${pre}${quote}${APP_URL}/api/track/click?t=${token}&l=${idx}${quote}`;
    },
  );

  return { html: rewritten + OPEN_PIXEL(token), links };
}
