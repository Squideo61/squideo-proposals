// /api/vimeo-oembed?url=<vimeo url> — same-origin proxy for Vimeo's public
// oEmbed endpoint. The client proposal page needs a video's title + poster
// thumbnail, but the app CSP is `connect-src 'self'`, so the browser can't
// fetch vimeo.com directly. We proxy it here and return just the two fields.
//
// Public (the client proposal page is unauthenticated) but not an open proxy:
// the target host is hard-coded to vimeo.com's oEmbed and the input must be a
// vimeo.com video URL, so it can only ever fetch Vimeo metadata. We forward the
// FULL url so unlisted videos keep their privacy hash (vimeo.com/ID/HASH).
import { cors } from './_lib/middleware.js';

const FETCH_TIMEOUT_MS = 6000;

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const raw = (req.query?.url || '').toString().trim();
  if (!raw) return res.status(400).json({ error: 'missing url' });

  let target;
  try { target = new URL(raw); } catch { return res.status(400).json({ error: 'bad url' }); }
  // Only real Vimeo video URLs — never let this fetch an arbitrary host.
  if (target.protocol !== 'https:' || !/^(www\.)?vimeo\.com$/.test(target.hostname) || !/\/\d+/.test(target.pathname)) {
    return res.status(400).json({ error: 'not a vimeo url' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const oembed = 'https://vimeo.com/api/oembed.json?width=640&url=' + encodeURIComponent(target.toString());
    const upstream = await fetch(oembed, { signal: controller.signal });
    if (!upstream.ok) return res.status(200).json({ title: null, thumbnail: null });
    const json = await upstream.json();
    // Cache at the edge for a day — video metadata rarely changes.
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400');
    return res.status(200).json({
      title: json?.title ? String(json.title) : null,
      thumbnail: json?.thumbnail_url ? String(json.thumbnail_url) : null,
    });
  } catch {
    return res.status(200).json({ title: null, thumbnail: null });
  } finally {
    clearTimeout(timer);
  }
}
