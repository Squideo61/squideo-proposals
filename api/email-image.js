// /api/email-image?u=<encoded image url> — same-origin image proxy for CRM
// email bodies. Third-party email images (signatures, banners — often on
// tracker CDNs like HubSpot) render in Gmail because Gmail proxies every remote
// image through its own domain, but when our viewer loads them directly they're
// frequently killed by ad/tracker blockers or domain reputation. The email
// viewers rewrite each <img src> to point here; we fetch the image server-side
// and stream it back from our own origin so it always loads.
//
// Auth: requires a logged-in user. The same-origin <img> request carries the
// HttpOnly session cookie automatically, so this is never an open proxy.
// SSRF-guarded: http(s) only, public hosts only (no loopback / private /
// link-local / reserved IPs — incl. the cloud metadata endpoint), image
// content-types only, with size + time caps.
import dns from 'node:dns/promises';
import net from 'node:net';
import { cors, requireAuth } from './_lib/middleware.js';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — generous for a banner, bounds abuse
const FETCH_TIMEOUT_MS = 8000;

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const user = await requireAuth(req, res);
  if (!user) return; // requireAuth already sent 401

  const raw = (req.query?.u || '').toString();
  if (!raw) return res.status(400).send('missing url');

  let url;
  try { url = new URL(raw); } catch { return res.status(400).send('bad url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return res.status(400).send('unsupported scheme');
  }

  // SSRF guard: resolve the host and reject anything that points at a non-public
  // address (an authed user viewing a malicious email must not be able to make
  // us fetch internal services / the cloud metadata endpoint).
  if (await hostIsPrivate(url.hostname)) return res.status(400).send('blocked host');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      // Clean, referer-free fetch (mirrors Gmail's proxy); we never forward the
      // viewer's cookies/headers to the third party.
      headers: { 'User-Agent': 'SquideoMailImageProxy/1.0', Accept: 'image/*' },
    });
  } catch {
    clearTimeout(timer);
    return res.status(502).send('fetch failed');
  }
  clearTimeout(timer);

  if (!upstream.ok) return res.status(502).send('upstream ' + upstream.status);
  const contentType = (upstream.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
  if (!contentType.startsWith('image/')) return res.status(415).send('not an image');

  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) return res.status(413).send('too large');

  // Read with a hard byte cap — Content-Length may be missing or lie.
  let body;
  try {
    body = await readCapped(upstream, MAX_BYTES);
  } catch (err) {
    if (err?.tooLarge) return res.status(413).send('too large');
    return res.status(502).send('read failed');
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(body.length));
  // Cache per-user in the browser; never let an intermediary share it, and lock
  // down what the proxied bytes can do if a content-type ever sneaks through.
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.status(200).end(body);
}

async function readCapped(resp, maxBytes) {
  const reader = resp.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > maxBytes) throw Object.assign(new Error('too large'), { tooLarge: true });
    return buf;
  }
  const chunks = [];
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw Object.assign(new Error('too large'), { tooLarge: true });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// True if `hostname` resolves to (or is) a non-public IP. Fails closed: an
// unresolvable host is treated as blocked.
async function hostIsPrivate(hostname) {
  if (net.isIP(hostname)) return isPrivateIp(hostname);
  let addrs;
  try { addrs = await dns.lookup(hostname, { all: true }); }
  catch { return true; }
  if (!addrs.length) return true;
  return addrs.some((a) => isPrivateIp(a.address));
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0) return true;                       // "this" network
    if (p[0] === 10) return true;                      // private
    if (p[0] === 127) return true;                     // loopback
    if (p[0] === 169 && p[1] === 254) return true;     // link-local (incl. 169.254.169.254 metadata)
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // private
    if (p[0] === 192 && p[1] === 168) return true;     // private
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] >= 224) return true;                      // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;        // loopback / unspecified
    if (lower.startsWith('fe80')) return true;                // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true; // not a recognisable IP → block
}
