import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import sql from '../db.js';
import { APP_URL } from '../email.js';
import {
  buildAuthUrl,
  encryptToken,
  decryptToken,
  exchangeCode,
  refreshAccessToken,
  fetchGmailAddress,
  fetchGmailSignature,
  registerWatch,
  stopWatch,
} from '../gmailTokens.js';
import { syncHistory } from '../gmailSync.js';
import {
  GMAIL_SCOPES,
  gmailRedirectUri,
  escapeHtml,
  trimOrNull,
} from './shared.js';
import { gmailBackfill } from './gmailBackfill.js';

export async function gmailRoute(req, res, id, action, user) {
  // /api/crm/gmail               GET   — current connection status for the user
  // /api/crm/gmail/connect       GET   — returns Google auth URL to redirect to
  // /api/crm/gmail/disconnect    POST  — revoke + clear stored token
  // /api/crm/gmail/send          POST  — send an email via Gmail API
  // /api/crm/gmail/callback      GET   — public, handled in top-level dispatch

  if (!id) {
    if (req.method !== 'GET') return res.status(405).end();
    const rows = await sql`
      SELECT gmail_address, scopes, connected_at, disconnected_at, history_id,
             backfill_started_at, backfill_completed_at, backfill_ingested,
             last_pushed_at
      FROM gmail_accounts WHERE user_email = ${user.email}
    `;
    if (!rows.length || rows[0].disconnected_at) {
      return res.status(200).json({ connected: false });
    }
    const row = rows[0];

    // Opportunistic poll-fallback: if a push hasn't arrived for >2h, kick off
    // a background sync so this user sees fresh mail within ~5 seconds even
    // if Pub/Sub silently dropped them. We rate-limit by stamping
    // last_pushed_at on success so we don't spam Gmail's history API.
    const pushAgeMs = row.last_pushed_at
      ? Date.now() - new Date(row.last_pushed_at).getTime()
      : Infinity;
    if (row.history_id && pushAgeMs > 2 * 60 * 60 * 1000) {
      waitUntil((async () => {
        try {
          const accessToken = await getFreshAccessToken(user.email);
          const result = await syncHistory({
            userEmail: user.email,
            accessToken,
            fromHistoryId: row.history_id,
          });
          if (result.latestHistoryId && result.latestHistoryId !== row.history_id) {
            await sql`
              UPDATE gmail_accounts
                 SET history_id = ${result.latestHistoryId},
                     last_pushed_at = NOW(),
                     updated_at = NOW()
               WHERE user_email = ${user.email}
            `;
          } else {
            // Even if no new messages, stamp last_pushed_at so we don't poll
            // again on the next request — the next sweep gives Pub/Sub another
            // 2 hours to deliver before we bother Gmail's API again.
            await sql`UPDATE gmail_accounts SET last_pushed_at = NOW() WHERE user_email = ${user.email}`;
          }
        } catch (err) {
          console.warn('[gmail inline poll-fallback]', user.email, err.message);
        }
      })());
    }

    return res.status(200).json({
      connected: true,
      gmailAddress: row.gmail_address,
      scopes: row.scopes,
      connectedAt: row.connected_at,
      backfillStartedAt: row.backfill_started_at || null,
      backfillCompletedAt: row.backfill_completed_at || null,
      backfillIngested: row.backfill_ingested ?? 0,
      lastPushedAt: row.last_pushed_at || null,
    });
  }

  if (id === 'connect') {
    if (req.method !== 'GET') return res.status(405).end();
    // CSRF-safe state token. We bind it to the user's email so an attacker
    // can't trade somebody else's authorisation code for their own account.
    const state = crypto.randomBytes(32).toString('base64url');
    await sql`
      INSERT INTO oauth_states (state, user_email, purpose)
      VALUES (${state}, ${user.email}, 'gmail-connect')
    `;
    // Best-effort cleanup of states older than 10 minutes.
    await sql`DELETE FROM oauth_states WHERE created_at < NOW() - INTERVAL '10 minutes'`;
    const url = buildAuthUrl({
      state,
      redirectUri: gmailRedirectUri(req),
      scopes: GMAIL_SCOPES,
    });
    return res.status(200).json({ url });
  }

  if (id === 'disconnect') {
    if (req.method !== 'POST') return res.status(405).end();
    const rows = await sql`
      SELECT refresh_token_enc, refresh_token_iv, refresh_token_tag
      FROM gmail_accounts WHERE user_email = ${user.email} AND disconnected_at IS NULL
    `;
    if (rows.length) {
      // Best-effort cleanup at Google's end. Revoking the refresh token also
      // invalidates any access token, but we proactively call users.stop too
      // so they tear down the Pub/Sub watch immediately rather than waiting
      // for it to expire.
      try {
        const refreshToken = decryptToken({
          enc: rows[0].refresh_token_enc,
          iv: rows[0].refresh_token_iv,
          tag: rows[0].refresh_token_tag,
        });
        try {
          const accessToken = await getFreshAccessToken(user.email);
          await stopWatch(accessToken);
        } catch (err) {
          console.warn('[gmail disconnect] users.stop failed (ignoring)', err.message);
        }
        await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(refreshToken), {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
      } catch (err) {
        console.warn('[gmail disconnect] revoke failed (ignoring)', err.message);
      }
    }
    await sql`
      UPDATE gmail_accounts
         SET disconnected_at = NOW(),
             history_id = NULL,
             watch_expires_at = NULL,
             updated_at = NOW()
       WHERE user_email = ${user.email}
    `;
    return res.status(200).json({ ok: true });
  }

  if (id === 'send') {
    if (req.method !== 'POST') return res.status(405).end();
    return gmailSend(req, res, user);
  }

  if (id === 'signature') {
    if (req.method !== 'GET') return res.status(405).end();
    const rows = await sql`
      SELECT signature_html, signature_fetched_at
      FROM gmail_accounts
      WHERE user_email = ${user.email} AND disconnected_at IS NULL
    `;
    if (!rows.length) {
      return res.status(200).json({ signatureHtml: null, fetchedAt: null });
    }
    return res.status(200).json({
      signatureHtml: rows[0].signature_html || null,
      fetchedAt: rows[0].signature_fetched_at || null,
    });
  }

  if (id === 'backfill') {
    if (req.method !== 'POST') return res.status(405).end();
    return gmailBackfill(req, res, user);
  }

  return res.status(404).json({ error: 'Unknown gmail action: ' + id });
}

export async function gmailCallback(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  // Parse query params from req.url since req.query parsing was unreliable
  // for the catch-all routing earlier.
  const qs = (req.url || '').split('?')[1] || '';
  const params = new URLSearchParams(qs);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');

  const renderResult = (title, body) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).end(`<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#FAFBFC;color:#0F2A3D;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}main{background:#fff;border:1px solid #E5E9EE;border-radius:12px;padding:32px;max-width:440px;text-align:center;box-shadow:0 4px 20px rgba(15,42,61,0.06)}h1{font-size:18px;margin:0 0 12px}p{color:#6B7785;font-size:14px;margin:0 0 18px;line-height:1.5}a{display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px}</style></head>
<body><main>${body}<p style="margin-top:18px"><a href="${APP_URL}/">Back to Squideo</a></p></main></body></html>`);
  };

  if (error) {
    return renderResult('Connection cancelled', `<h1>Connection cancelled</h1><p>${escapeHtml(error)}</p>`);
  }
  if (!code || !state) {
    return renderResult('Connection failed', `<h1>Connection failed</h1><p>Missing code or state in the callback. Try again.</p>`);
  }

  // Validate state and look up which user it belongs to.
  const stateRows = await sql`
    SELECT user_email, purpose, created_at FROM oauth_states WHERE state = ${state}
  `;
  if (!stateRows.length) {
    return renderResult('Connection failed', `<h1>Connection failed</h1><p>State token unknown or expired. Try connecting again.</p>`);
  }
  const ageMs = Date.now() - new Date(stateRows[0].created_at).getTime();
  if (stateRows[0].purpose !== 'gmail-connect' || ageMs > 10 * 60 * 1000) {
    await sql`DELETE FROM oauth_states WHERE state = ${state}`;
    return renderResult('Connection failed', `<h1>Connection failed</h1><p>State token expired. Try connecting again.</p>`);
  }
  const userEmail = stateRows[0].user_email;
  await sql`DELETE FROM oauth_states WHERE state = ${state}`;

  // Exchange the auth code for tokens.
  let tokens;
  try {
    tokens = await exchangeCode(code, gmailRedirectUri(req));
  } catch (err) {
    console.error('[gmail callback] code exchange failed', err);
    return renderResult('Connection failed', `<h1>Connection failed</h1><p>${escapeHtml(err.message || 'Token exchange error.')}</p>`);
  }

  if (!tokens.refresh_token) {
    return renderResult('Connection failed', `<h1>Connection failed</h1><p>Google did not return a refresh token. Disconnect any prior connection from your Google account, then try again.</p>`);
  }

  // Confirm the access token is valid and grab the Gmail address.
  let gmailAddress;
  try {
    gmailAddress = await fetchGmailAddress(tokens.access_token);
  } catch (err) {
    console.error('[gmail callback] profile fetch failed', err);
    return renderResult('Connection failed', `<h1>Connection failed</h1><p>${escapeHtml(err.message || 'Could not read Gmail profile.')}</p>`);
  }

  const { enc, iv, tag } = encryptToken(tokens.refresh_token);
  const accessExpiresAt = new Date(Date.now() + (Number(tokens.expires_in || 3600) - 60) * 1000).toISOString();

  // Register a Gmail push subscription on the configured Pub/Sub topic so
  // we receive a notification whenever new mail arrives. Best-effort — if
  // it fails (e.g. topic not configured) we still persist the tokens so the
  // user can at least send email; the daily cron will retry.
  let historyId = null;
  let watchExpiresAt = null;
  let pubsubTopic = process.env.GMAIL_PUBSUB_TOPIC || null;
  if (pubsubTopic) {
    try {
      const watch = await registerWatch(tokens.access_token, pubsubTopic);
      historyId = watch.historyId || null;
      watchExpiresAt = watch.expiration ? new Date(watch.expiration).toISOString() : null;
    } catch (err) {
      console.error('[gmail callback] users.watch failed', err.message);
    }
  } else {
    console.warn('[gmail callback] GMAIL_PUBSUB_TOPIC not set — skipping watch registration');
  }

  await sql`
    INSERT INTO gmail_accounts (
      user_email, gmail_address,
      refresh_token_enc, refresh_token_iv, refresh_token_tag,
      access_token, access_token_expires_at,
      history_id, watch_expires_at, pubsub_topic,
      scopes, connected_at, disconnected_at, updated_at
    ) VALUES (
      ${userEmail}, ${gmailAddress},
      ${enc}, ${iv}, ${tag},
      ${tokens.access_token}, ${accessExpiresAt},
      ${historyId}, ${watchExpiresAt}, ${pubsubTopic},
      ${tokens.scope || GMAIL_SCOPES.join(' ')}, NOW(), NULL, NOW()
    )
    ON CONFLICT (user_email) DO UPDATE SET
      gmail_address = EXCLUDED.gmail_address,
      refresh_token_enc = EXCLUDED.refresh_token_enc,
      refresh_token_iv = EXCLUDED.refresh_token_iv,
      refresh_token_tag = EXCLUDED.refresh_token_tag,
      access_token = EXCLUDED.access_token,
      access_token_expires_at = EXCLUDED.access_token_expires_at,
      history_id = COALESCE(EXCLUDED.history_id, gmail_accounts.history_id),
      watch_expires_at = COALESCE(EXCLUDED.watch_expires_at, gmail_accounts.watch_expires_at),
      pubsub_topic = COALESCE(EXCLUDED.pubsub_topic, gmail_accounts.pubsub_topic),
      scopes = EXCLUDED.scopes,
      connected_at = NOW(),
      disconnected_at = NULL,
      updated_at = NOW()
  `;

  // Pull the user's Gmail signature in the background so the next CRM-sent
  // email mirrors it. Fire-and-forget — connecting must not block on this.
  waitUntil(refreshSignatureCache(userEmail));

  // Kick off the 30-day backfill so the user's deal timelines populate
  // immediately. waitUntil keeps Vercel from killing the request before it
  // actually leaves the box (plain fire-and-forget gets cut off when the
  // function returns).
  if (process.env.CRON_SECRET) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const backfillUrl = `${proto}://${host}/api/crm/gmail/backfill?userEmail=${encodeURIComponent(userEmail)}`;
    waitUntil(
      fetch(backfillUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.CRON_SECRET },
      }).catch(err => console.warn('[gmail callback] backfill kick-off failed (ignoring)', err.message))
    );
  }

  return renderResult(
    'Gmail connected',
    `<h1>Gmail connected ✓</h1><p><strong>${escapeHtml(gmailAddress)}</strong> is now linked to your Squideo account.</p><p>${historyId ? 'Inbound sync is active — new mail will appear on the matching deal automatically.' : 'Inbound sync could not be activated (Pub/Sub may need attention) — outbound send still works.'}</p><p>The last 30 days of mail are being backfilled in the background. You can close this tab.</p>`
  );
}

// Pull the user's current Gmail signature via the API and persist it on the
// gmail_accounts row. Best-effort — caller should fire-and-forget so a
// signature outage never blocks send/connect. Reuses getFreshAccessToken so
// the access token gets refreshed if it had expired.
export async function refreshSignatureCache(userEmail) {
  try {
    const accessToken = await getFreshAccessToken(userEmail);
    const sig = await fetchGmailSignature(accessToken);
    await sql`
      UPDATE gmail_accounts
         SET signature_html = ${sig},
             signature_fetched_at = NOW(),
             updated_at = NOW()
       WHERE user_email = ${userEmail}
    `;
  } catch (err) {
    console.warn('[gmail signature refresh]', userEmail, err.message);
  }
}

// Fetch a fresh access token, refreshing via Google if the cached one is
// stale. Persists the new access_token + expiry. Throws if the user isn't
// connected or Google has revoked the refresh token.
export async function getFreshAccessToken(userEmail) {
  const rows = await sql`
    SELECT refresh_token_enc, refresh_token_iv, refresh_token_tag,
           access_token, access_token_expires_at
    FROM gmail_accounts
    WHERE user_email = ${userEmail} AND disconnected_at IS NULL
  `;
  if (!rows.length) {
    const err = new Error('Gmail not connected');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const row = rows[0];
  const expiresAt = row.access_token_expires_at ? new Date(row.access_token_expires_at).getTime() : 0;
  if (row.access_token && expiresAt > Date.now() + 30_000) {
    return row.access_token;
  }
  const refreshToken = decryptToken({
    enc: row.refresh_token_enc,
    iv: row.refresh_token_iv,
    tag: row.refresh_token_tag,
  });
  let refreshed;
  try {
    refreshed = await refreshAccessToken(refreshToken);
  } catch (err) {
    if (String(err.message).includes('invalid_grant')) {
      // Token was revoked at Google's end — flag the account so the UI can
      // prompt the user to reconnect.
      await sql`
        UPDATE gmail_accounts
           SET disconnected_at = NOW(), updated_at = NOW()
         WHERE user_email = ${userEmail}
      `;
      const e = new Error('Gmail authorisation expired. Reconnect to continue.');
      e.code = 'REAUTH';
      throw e;
    }
    throw err;
  }
  await sql`
    UPDATE gmail_accounts
       SET access_token = ${refreshed.accessToken},
           access_token_expires_at = ${refreshed.expiresAt.toISOString()},
           updated_at = NOW()
     WHERE user_email = ${userEmail}
  `;
  return refreshed.accessToken;
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function cleanEmailList(value) {
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  return raw
    .filter(v => typeof v === 'string')
    .map(v => v.trim())
    .filter(v => EMAIL_RX.test(v));
}

export async function gmailSend(req, res, user) {
  const body = req.body || {};
  const to = cleanEmailList(body.to);
  const cc = cleanEmailList(body.cc);
  const bcc = cleanEmailList(body.bcc);
  const subject = trimOrNull(body.subject);
  const html = body.html || '';
  const text = body.text || '';
  const dealId = trimOrNull(body.dealId);
  const threadId = trimOrNull(body.gmailThreadId);

  if (!to.length) return res.status(400).json({ error: 'to is required and must contain at least one valid email' });
  if (!subject) return res.status(400).json({ error: 'subject is required' });
  if (!html && !text) return res.status(400).json({ error: 'html or text body is required' });

  let accessToken;
  try {
    accessToken = await getFreshAccessToken(user.email);
  } catch (err) {
    if (err.code === 'NOT_CONNECTED' || err.code === 'REAUTH') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const acctRow = (await sql`
    SELECT gmail_address, signature_html, signature_fetched_at
    FROM gmail_accounts WHERE user_email = ${user.email}
  `)[0] || {};
  const fromAddress = acctRow.gmail_address;
  const signatureHtml = acctRow.signature_html || '';

  // Refresh the cached signature in the background if it's stale (>1h old or
  // never fetched). Don't await — the current send uses the cached value.
  const sigFetchedAt = acctRow.signature_fetched_at
    ? new Date(acctRow.signature_fetched_at).getTime()
    : 0;
  if (Date.now() - sigFetchedAt > 60 * 60 * 1000) {
    waitUntil(refreshSignatureCache(user.email));
  }

  // Append the signature to both the HTML and text bodies so multipart
  // recipients see it in either rendering path. Gmail returns sanitised HTML
  // for the signature already, so we trust it here.
  let htmlOut = html || '';
  let textOut = text || '';
  if (signatureHtml) {
    if (htmlOut) htmlOut = htmlOut + '<br><br>' + signatureHtml;
    if (textOut) textOut = textOut + '\n\n' + signatureHtml.replace(/<[^>]+>/g, '').replace(/\s+\n/g, '\n').trim();
  }

  // Build the RFC 2822 message. Add the X-Squideo-Deal header so server-side
  // sync (Phase 3) can thread continuity even if the recipient drops it.
  const fromName = user.name || fromAddress;
  const fromHeader = fromName && fromName !== fromAddress
    ? `${quoteHeader(fromName)} <${fromAddress}>`
    : fromAddress;
  const headers = [
    `From: ${fromHeader}`,
    `To: ${to.join(', ')}`,
    cc.length ? `Cc: ${cc.join(', ')}` : null,
    bcc.length ? `Bcc: ${bcc.join(', ')}` : null,
    `Subject: ${encodeMimeHeader(subject)}`,
    'MIME-Version: 1.0',
    dealId ? `X-Squideo-Deal: ${dealId}` : null,
  ].filter(Boolean);

  let mime;
  if (htmlOut && textOut) {
    const boundary = 'sqd_' + crypto.randomBytes(8).toString('hex');
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    mime = headers.join('\r\n') + '\r\n\r\n'
      + `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${textOut}\r\n`
      + `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${htmlOut}\r\n`
      + `--${boundary}--\r\n`;
  } else if (htmlOut) {
    headers.push('Content-Type: text/html; charset=UTF-8');
    mime = headers.join('\r\n') + '\r\n\r\n' + htmlOut;
  } else {
    headers.push('Content-Type: text/plain; charset=UTF-8');
    mime = headers.join('\r\n') + '\r\n\r\n' + textOut;
  }

  const raw = Buffer.from(mime, 'utf8').toString('base64url');

  const sendBody = { raw };
  if (threadId) sendBody.threadId = threadId;

  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(sendBody),
  });
  if (!sendRes.ok) {
    const errBody = await sendRes.text();
    console.error('[gmail send] failed', sendRes.status, errBody);
    return res.status(502).json({ error: `Gmail send failed (${sendRes.status})` });
  }
  const sent = await sendRes.json();

  // Log to the deal timeline so the user sees what they sent.
  if (dealId) {
    try {
      await sql`
        INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
        VALUES (
          ${dealId}, 'email_sent',
          ${JSON.stringify({
            messageId: sent.id,
            threadId: sent.threadId,
            to, cc, subject,
            fromAddress,
          })},
          ${user.email}
        )
      `;
      await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${dealId}`;
    } catch (err) {
      console.error('[gmail send] deal_events insert failed', err);
    }
  }

  return res.status(200).json({
    ok: true,
    messageId: sent.id,
    threadId: sent.threadId,
  });
}

// Encode a header value with RFC 2047 if it contains non-ASCII.
function encodeMimeHeader(value) {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function quoteHeader(name) {
  // Quote display names that contain special chars; otherwise leave bare.
  if (/^[\w \-.]+$/.test(name)) return name;
  return `"${name.replace(/"/g, '\\"')}"`;
}
