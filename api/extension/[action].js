// Chrome extension authentication endpoints. Three sub-routes:
//
//   GET  /api/extension/auth-page?return=<chrome-cb-url>
//      HTML page that runs in the user's browser, reads their session JWT
//      from localStorage, exchanges it for a long-lived extension token, and
//      redirects to the extension's callback URL with the token in the URL
//      fragment. Triggered by chrome.identity.launchWebAuthFlow.
//
//   POST /api/extension/exchange
//      Mints a fresh 90-day extension token bound to the calling user.
//      Auth: the caller's normal session JWT (Authorization: Bearer ...).
//
//   POST /api/extension/refresh
//      Pushes the expiry of an extension token out by another 90 days.
//      Auth: the extension token itself.

import crypto from 'node:crypto';
import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';

const TOKEN_TTL_DAYS = 90;

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const urlPath = (req.url || '').split('?')[0];
  const segs = urlPath.split('/').filter(Boolean).slice(2); // strip 'api', 'extension'
  const action = segs[0] || null;

  try {
    switch (action) {
      case 'auth-page': return authPage(req, res);
      case 'exchange':  return exchange(req, res);
      case 'refresh':   return refresh(req, res);
      default:          return res.status(404).json({ error: 'Unknown action: ' + action });
    }
  } catch (err) {
    console.error('[extension] unhandled', { action, method: req.method, err });
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}

// Tiny HTML page that completes the OAuth-like handshake. Served at
// /api/extension/auth-page so the extension's chrome.identity flow has a
// stable URL to launch and watch. We can't read localStorage from the server,
// so the page itself does the exchange in the browser then redirects back to
// the extension with the token in the URL fragment.
function authPage(req, res) {
  const qs = (req.url || '').split('?')[1] || '';
  const params = new URLSearchParams(qs);
  const returnTo = params.get('return') || '';

  if (!returnTo || !isValidChromeReturnUrl(returnTo)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).end(renderError('Invalid return URL — must be a chrome-extension callback (https://&lt;ext-id&gt;.chromiumapp.org).'));
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Connecting Squideo…</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;background:#FAFBFC;color:#0F2A3D;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
main{background:#fff;border:1px solid #E5E9EE;border-radius:12px;padding:32px;max-width:440px;text-align:center;box-shadow:0 4px 20px rgba(15,42,61,0.06)}
h1{font-size:18px;margin:0 0 12px}
p{color:#6B7785;font-size:14px;margin:0 0 18px;line-height:1.5}
a{display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px}
.err{color:#DC2626}
</style></head>
<body><main id="status"><h1>Connecting Squideo extension…</h1><p>One moment.</p></main>
<script>
(async () => {
  const status = document.getElementById('status');
  const jwt = localStorage.getItem('squideo.jwt');
  const returnTo = ${JSON.stringify(returnTo)};
  if (!jwt) {
    status.innerHTML = '<h1>Sign in first</h1><p>Open Squideo in this tab and sign in, then re-open the extension popup.</p><p><a href="/">Go to Squideo</a></p>';
    return;
  }
  try {
    const r = await fetch('/api/extension/exchange', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + jwt, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAgent: navigator.userAgent.slice(0, 200) }),
    });
    const data = await r.json();
    if (!r.ok || !data.token) throw new Error(data.error || 'Exchange failed');
    location.replace(returnTo + '#token=' + encodeURIComponent(data.token) + '&expiresAt=' + encodeURIComponent(data.expiresAt));
  } catch (err) {
    status.innerHTML = '<h1 class="err">Could not connect</h1><p>' + ((err && err.message) || 'Try again.') + '</p>';
  }
})();
</script>
</body></html>`);
}

async function exchange(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const user = await requireAuth(req, res);
  if (!user) return; // requireAuth already responded
  // Don't let an extension token exchange itself for another extension token —
  // exchange must come from a normal session JWT.
  if (user.via === 'extension-token') {
    return res.status(403).json({ error: 'Use /refresh to extend an extension token' });
  }

  const body = req.body || {};
  const userAgent = String(body.userAgent || req.headers['user-agent'] || '').slice(0, 500);
  const token = 'ext_' + crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await sql`
    INSERT INTO extension_tokens (token, user_email, expires_at, user_agent)
    VALUES (${token}, ${user.email}, ${expiresAt}, ${userAgent})
  `;
  // Best-effort cleanup of stale/revoked tokens for this user so the table
  // doesn't grow unbounded after a year of casual extension installs.
  sql`
    DELETE FROM extension_tokens
    WHERE user_email = ${user.email}
      AND (revoked_at IS NOT NULL OR expires_at < NOW() - INTERVAL '30 days')
  `.catch(() => {});

  return res.status(200).json({ token, expiresAt });
}

async function refresh(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorised' });

  const rows = await sql`
    SELECT user_email FROM extension_tokens
    WHERE token = ${token} AND revoked_at IS NULL AND expires_at > NOW()
    LIMIT 1
  `;
  if (!rows.length) return res.status(401).json({ error: 'Token invalid or expired' });

  const newExpiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await sql`
    UPDATE extension_tokens
       SET expires_at = ${newExpiresAt}, last_seen_at = NOW()
     WHERE token = ${token}
  `;
  return res.status(200).json({ ok: true, expiresAt: newExpiresAt });
}

function isValidChromeReturnUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /\.chromiumapp\.org$/.test(u.hostname);
  } catch {
    return false;
  }
}

function renderError(msg) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Error</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#FAFBFC;color:#0F2A3D;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}main{background:#fff;border:1px solid #E5E9EE;border-radius:12px;padding:32px;max-width:440px;text-align:center}</style>
</head><body><main><h1 style="color:#DC2626;margin:0 0 12px;font-size:18px">Could not connect</h1><p style="color:#6B7785;font-size:14px;margin:0">${msg}</p></main></body></html>`;
}
