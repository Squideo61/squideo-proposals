// Shared Google OAuth — exchange a long-lived refresh token for a short-lived
// access token. Used by the GA4 (Analytics Data API) and Search Console syncs,
// which share ONE refresh token (GOOGLE_OAUTH_REFRESH_TOKEN, granted the
// analytics.readonly + webmasters.readonly scopes) and reuse the existing Google
// Ads OAuth client credentials unless explicitly overridden. Mirrors the
// refresh-token flow in googleAds.js / gmail.js.

const clientId = () => process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_ADS_CLIENT_ID;
const clientSecret = () => process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_ADS_CLIENT_SECRET;
const refreshToken = () => process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

// True once the shared client + refresh token are present. The per-product
// configured() helpers additionally require their property id / site url.
export function googleOAuthConfigured() {
  return !!(clientId() && clientSecret() && refreshToken());
}

// Cache the access token in module scope, keyed by the refresh token so a token
// rotation can't serve a stale value. Refreshed ~1 min before expiry.
const cache = new Map(); // refreshToken -> { value, expiresAt }

export async function getGoogleApiToken() {
  const rt = refreshToken();
  if (!clientId() || !clientSecret() || !rt) throw new Error('Google OAuth is not configured');
  const hit = cache.get(rt);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.value;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: rt,
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.access_token) {
    throw new Error('Google OAuth failed: ' + (json.error_description || json.error || r.status));
  }
  cache.set(rt, {
    value: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  });
  return cache.get(rt).value;
}
