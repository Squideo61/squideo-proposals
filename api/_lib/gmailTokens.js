// AES-256-GCM symmetric encryption for Gmail refresh tokens at rest.
// The key lives in env GMAIL_TOKEN_KEY as 64 hex chars (32 bytes).
import crypto from 'node:crypto';

function getKey() {
  const hex = process.env.GMAIL_TOKEN_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('GMAIL_TOKEN_KEY must be 64 hex chars (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptToken(plaintext) {
  if (!plaintext) throw new Error('plaintext required');
  const key = getKey();
  const iv = crypto.randomBytes(12); // GCM standard
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc, iv, tag };
}

export function decryptToken({ enc, iv, tag }) {
  const key = getKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv));
  decipher.setAuthTag(Buffer.from(tag));
  const plain = Buffer.concat([decipher.update(Buffer.from(enc)), decipher.final()]);
  return plain.toString('utf8');
}

// Exchange a refresh token for a fresh access token. Caches per-call only;
// the caller is responsible for persisting the new access_token + expiry on
// the gmail_accounts row.
export async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google token refresh failed (${res.status}): ${body}`);
  }
  const json = await res.json();
  return {
    accessToken: json.access_token,
    expiresIn: json.expires_in,
    expiresAt: new Date(Date.now() + (json.expires_in - 60) * 1000),
    scope: json.scope,
  };
}

// Exchange an authorisation code (from /api/crm/gmail/callback) for tokens.
export async function exchangeCode(code, redirectUri) {
  const params = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google code exchange failed (${res.status}): ${body}`);
  }
  return res.json();
}

// Fetch the authenticated user's Gmail address (also confirms the access
// token is valid before we persist it). Uses the userinfo endpoint which is
// covered by the gmail.readonly scope plus the email claim Google adds for
// any consented scope.
export async function fetchGmailAddress(accessToken) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail profile fetch failed (${res.status}): ${body}`);
  }
  const json = await res.json();
  return json.emailAddress;
}

// Build the Google authorisation URL. `state` must be a CSRF-safe random
// string we've persisted server-side. `prompt=consent` forces the consent
// screen so we always get a refresh_token (Google omits it on subsequent
// authorisations otherwise).
export function buildAuthUrl({ state, redirectUri, scopes }) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

// Subscribe the user's mailbox to a Pub/Sub topic so Gmail will push us a
// notification whenever new mail arrives. Returns { historyId, expiration }.
// `expiration` is Unix milliseconds (Gmail's watches expire ~7 days out, so
// a daily cron must call this again before then).
export async function registerWatch(accessToken, topicName) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/watch', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      topicName,
      labelIds: ['INBOX', 'SENT'],
      labelFilterBehavior: 'INCLUDE',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail users.watch failed (${res.status}): ${body}`);
  }
  const json = await res.json();
  return {
    historyId: json.historyId,
    expiration: json.expiration ? Number(json.expiration) : null,
  };
}

// Cancel an existing Gmail watch. Best-effort — Gmail will let it expire on
// its own anyway.
export async function stopWatch(accessToken) {
  await fetch('https://gmail.googleapis.com/gmail/v1/users/me/stop', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken },
  });
}

// Fetch the user's primary Gmail signature via users.settings.sendAs.
// Requires the gmail.modify scope (already granted alongside .readonly).
// Returns the raw HTML string, or null if no signature is set / call fails.
export async function fetchGmailSignature(accessToken) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!res.ok) {
    console.warn('[gmail signature] sendAs fetch failed', res.status);
    return null;
  }
  const json = await res.json();
  const list = Array.isArray(json.sendAs) ? json.sendAs : [];
  // Prefer the primary identity, then the default-reply identity, then first.
  const primary = list.find(s => s.isPrimary) || list.find(s => s.isDefault) || list[0];
  return primary?.signature || null;
}
