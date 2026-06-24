import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { put, del, get } from '@vercel/blob';
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
  googleScopes,
  scopesCoverCalendar,
  gmailRedirectUri,
  escapeHtml,
  trimOrNull,
} from './shared.js';
import { gmailBackfill } from './gmailBackfill.js';
import { mailboxLive } from './mailbox.js';
import { instrumentHtml, newTrackingToken, recordTrackedSend } from './tracking.js';

// One-shot per cold start: ensure the gmail signature columns exist. Belongs
// in the manual Neon migration but absent on workspaces where that step was
// skipped, in which case every SELECT/UPDATE that touches signature_html 500s
// with 'column does not exist'. The ALTER is idempotent. Module-level cached
// so a successful first call short-circuits subsequent ones for free.
let signatureColumnsEnsured = null;
async function ensureSignatureColumns() {
  if (signatureColumnsEnsured) return signatureColumnsEnsured;
  signatureColumnsEnsured = (async () => {
    try {
      await sql`
        ALTER TABLE gmail_accounts
          ADD COLUMN IF NOT EXISTS signature_html TEXT,
          ADD COLUMN IF NOT EXISTS signature_fetched_at TIMESTAMPTZ
      `;
    } catch (err) {
      // Don't cache a failure — retry on the next request so a transient DB
      // hiccup doesn't strand the workspace.
      signatureColumnsEnsured = null;
      console.warn('[gmail signature] ensureSignatureColumns failed', err.message);
    }
  })();
  return signatureColumnsEnsured;
}

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
      // True when this (possibly long-connected) account predates the Calendar
      // scopes — the Intro Call booking UI prompts them to reconnect.
      needsCalendar: !scopesCoverCalendar(row.scopes),
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
      scopes: googleScopes(),
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
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();
    // Self-heal: db/migrations/20260512_gmail_signature.sql adds these two
    // columns but has to be applied manually via the Neon SQL editor (see
    // DEPLOYMENT-GUIDE.md). If a deploy went out without that step, every
    // query below 500s with 'column "signature_html" does not exist'. The
    // ALTER is idempotent (IF NOT EXISTS) and module-level cached so we only
    // pay for it on the first signature request per cold start.
    await ensureSignatureColumns();
    const rows = await sql`
      SELECT signature_html, signature_fetched_at
      FROM gmail_accounts
      WHERE user_email = ${user.email} AND disconnected_at IS NULL
    `;
    if (!rows.length) {
      // Account row missing or disconnected. The other gmailAccount endpoint
      // would normally have told the frontend to hide the signature section,
      // but if state is stale (e.g. account was disconnected after the page
      // loaded) we may still get hit here — return a diagnostic instead of a
      // bare null so the UI explains the situation.
      return res.status(200).json({
        signatureHtml: null,
        fetchedAt: null,
        gmailConnected: false,
        diagnostics: {
          html: null, summary: [], pickedEmail: null,
          error: { stage: 'disconnected', message: 'Gmail account is not connected for this user. Reconnect from Account → Gmail integration.', code: 'NOT_CONNECTED' },
        },
      });
    }
    const cachedHtml = rows[0].signature_html || null;
    const fetchedAt = rows[0].signature_fetched_at || null;
    const ageMs = fetchedAt ? Date.now() - new Date(fetchedAt).getTime() : Infinity;
    const STALE_MS = 60 * 60 * 1000;

    // POST = explicit "Refresh from Gmail" click. Force the refresh and
    // return the full diagnostic so the UI can show why it came back empty.
    // GET with an empty cache also refreshes inline (no throttle — Gmail's
    // sendAs quota is generous, and the throttle stranded users whose first
    // fetch happened before they set up their signature). The diagnostic
    // comes back attached so the UI can explain the empty state when it
    // genuinely is empty.
    if (req.method === 'POST' || !cachedHtml) {
      // Belt-and-braces: refreshSignatureCache itself returns a diagnostic on
      // expected failures (token / API errors), but anything unexpected (DB
      // hiccup, JSON parse) used to fall through to the dispatcher's 500
      // handler — which strips the diagnostic and leaves the UI on the
      // "!diagnostics" branch the user is stuck on. Catch here so the modal
      // always gets a structured reason instead of an opaque 500.
      let diag;
      try {
        diag = await refreshSignatureCache(user.email);
      } catch (err) {
        console.error('[gmail signature] refresh threw', user.email, err);
        diag = { html: null, summary: [], pickedEmail: null, error: { stage: 'unexpected', message: err.message || 'Unknown error', code: err.code || null } };
      }
      const fresh = await sql`
        SELECT signature_html, signature_fetched_at
        FROM gmail_accounts
        WHERE user_email = ${user.email}
      `;
      return res.status(200).json({
        signatureHtml: fresh[0]?.signature_html || null,
        fetchedAt: fresh[0]?.signature_fetched_at || null,
        diagnostics: diag,
      });
    }
    if (ageMs > STALE_MS) {
      waitUntil(refreshSignatureCache(user.email));
    }
    return res.status(200).json({ signatureHtml: cachedHtml, fetchedAt });
  }

  if (id === 'backfill') {
    if (req.method !== 'POST') return res.status(405).end();
    return gmailBackfill(req, res, user);
  }

  if (id === 'attachments') {
    return gmailAttachments(req, res, user);
  }

  if (id === 'inline-image') {
    return gmailInlineImage(req, res, user);
  }

  if (id === 'schedule') {
    return gmailSchedule(req, res, user);
  }

  // Live Gmail mailbox proxy for the Emails section's folders (Inbox, Sent,
  // Drafts, Spam, Trash, Starred, All Mail) + per-message actions. Delegated
  // to mailbox.js; reuses this resource's proven 2-segment routing.
  if (['folder', 'thread', 'attachment', 'modify', 'labels'].includes(id)) {
    return mailboxLive(req, res, id, user);
  }

  return res.status(404).json({ error: 'Unknown gmail action: ' + id });
}

// Upload (POST, raw binary) / delete (DELETE ?pathname=) a temporary email
// attachment. Stored in a private Vercel Blob namespace per user; embedded
// into the outgoing message at send time, then deleted. Mirrors the deal-file
// upload pattern in deals.js.
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

async function gmailAttachments(req, res, user) {
  if (req.method === 'POST') {
    if (!process.env.BLOB_READ_WRITE_TOKEN)
      return res.status(503).json({ error: 'File storage not configured' });

    const filename = decodeURIComponent(req.headers['x-filename'] || 'attachment');
    const mimeType = req.headers['content-type'] || 'application/octet-stream';

    let fileBuffer = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : null;
    if (!fileBuffer) {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      fileBuffer = Buffer.concat(chunks);
    }
    if (!fileBuffer || fileBuffer.length === 0)
      return res.status(400).json({ error: 'No file data received' });
    if (fileBuffer.length > ATTACHMENT_MAX_BYTES)
      return res.status(413).json({ error: 'File too large (max 20 MB)' });

    const fileId = crypto.randomUUID();
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    // Private store — performGmailSend / the scheduled-send cron read the
    // bytes back via the authenticated get(). Deleted right after send/cancel.
    const blob = await put(`email-attachments/${user.email}/${fileId}/${safeName}`, fileBuffer, {
      access: 'private', contentType: mimeType,
    });
    return res.status(201).json({
      filename, mimeType, sizeBytes: fileBuffer.length,
      blobUrl: blob.url, blobPathname: blob.pathname,
    });
  }

  if (req.method === 'DELETE') {
    const pathname = (req.query && req.query.pathname)
      || new URLSearchParams((req.url || '').split('?')[1] || '').get('pathname');
    if (pathname) {
      try { await del(pathname); } catch (err) { console.warn('[gmail attachments] delete failed', err?.message); }
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}

// GET /api/crm/gmail/inline-image?messageId=<id>&cid=<contentId>
// Resolve an inline (cid:) image embedded in an email body to its actual bytes
// and serve them same-origin, so the email viewers can render embedded images /
// signatures. Browsers can't load cid: URLs (only mail clients can) and our CSP
// blocks them, so the viewers rewrite cid: refs to point here.
//
// Uses the message OWNER's Gmail token — a deal email may have been synced by a
// teammate, and Gmail only serves a message to its own mailbox. Auth + image
// content-type enforced; the (messageId, cid) pair is immutable so we cache hard.
const INLINE_MSG_CACHE = new Map(); // messageId -> { payload, at } (warm-instance only)
const INLINE_MSG_TTL_MS = 60_000;

async function gmailInlineImage(req, res, user) {
  if (req.method !== 'GET') return res.status(405).end();
  const messageId = (req.query?.messageId || '').toString();
  let cid = (req.query?.cid || '').toString();
  if (!messageId || !cid) return res.status(400).json({ error: 'messageId and cid required' });
  cid = cid.replace(/^cid:/i, '').replace(/^<|>$/g, '').trim();

  // The message lives in whoever's mailbox synced it; fall back to the current
  // user (viewing their own live mailbox) when we have no record of it.
  let owner = user.email;
  try {
    const [row] = await sql`SELECT user_email FROM email_messages WHERE gmail_message_id = ${messageId} LIMIT 1`;
    if (row?.user_email) owner = row.user_email;
  } catch { /* fall back to current user */ }

  let accessToken;
  try { accessToken = await getFreshAccessToken(owner); }
  catch (err) {
    if (err.code === 'NOT_CONNECTED' || err.code === 'REAUTH') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
  let payload;
  const cached = INLINE_MSG_CACHE.get(messageId);
  if (cached && (Date.now() - cached.at) < INLINE_MSG_TTL_MS) {
    payload = cached.payload;
  } else {
    try {
      const r = await fetch(`${base}/messages/${encodeURIComponent(messageId)}?format=full`, {
        headers: { Authorization: 'Bearer ' + accessToken },
      });
      if (!r.ok) return res.status(502).send('message fetch failed');
      payload = (await r.json()).payload;
    } catch { return res.status(502).send('message fetch failed'); }
    INLINE_MSG_CACHE.set(messageId, { payload, at: Date.now() });
  }

  const part = findInlinePart(payload, cid);
  if (!part) return res.status(404).send('inline image not found');
  const mimeType = part.mimeType || 'application/octet-stream';
  if (!mimeType.startsWith('image/')) return res.status(415).send('not an image');

  let buf;
  if (part.body?.data) {
    buf = Buffer.from(part.body.data, 'base64url');
  } else if (part.body?.attachmentId) {
    try {
      const r = await fetch(
        `${base}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
        { headers: { Authorization: 'Bearer ' + accessToken } },
      );
      if (!r.ok) return res.status(502).send('attachment fetch failed');
      buf = Buffer.from((await r.json()).data || '', 'base64url');
    } catch { return res.status(502).send('attachment fetch failed'); }
  } else {
    return res.status(404).send('no image data');
  }

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  return res.status(200).end(buf);
}

// Walk a Gmail payload tree for the part whose Content-ID matches `cid` (with or
// without angle brackets). Falls back to matching the part's X-Attachment-Id or
// filename, which some senders reference instead.
function findInlinePart(payload, cid) {
  const want = cid.toLowerCase();
  let found = null;
  const walk = (part) => {
    if (!part || found) return;
    for (const h of part.headers || []) {
      const name = (h.name || '').toLowerCase();
      if (name === 'content-id' || name === 'x-attachment-id') {
        const val = (h.value || '').replace(/^<|>$/g, '').trim().toLowerCase();
        if (val === want) { found = part; return; }
      }
    }
    if (!found && (part.mimeType || '').startsWith('image/') && part.filename
        && part.filename.toLowerCase() === want) {
      found = part; return;
    }
    if (Array.isArray(part.parts)) for (const p of part.parts) walk(p);
  };
  walk(payload);
  return found;
}

// Schedule an email to send later, list a deal's pending scheduled sends, or
// cancel one. The actual send is performed by cronScheduledEmails (cron.js)
// once scheduled_for passes.
async function gmailSchedule(req, res, user) {
  if (req.method === 'GET') {
    const dealId = (req.query && req.query.dealId)
      || new URLSearchParams((req.url || '').split('?')[1] || '').get('dealId');
    if (!dealId) return res.status(400).json({ error: 'dealId is required' });
    const rows = await sql`
      SELECT id, payload, scheduled_for, created_at
      FROM scheduled_emails
      WHERE deal_id = ${dealId} AND user_email = ${user.email} AND status = 'pending'
      ORDER BY scheduled_for ASC
    `;
    return res.status(200).json(rows.map(r => ({
      id: r.id,
      subject: r.payload?.subject || '(no subject)',
      to: r.payload?.to || [],
      scheduledFor: r.scheduled_for,
      createdAt: r.created_at,
      attachmentCount: Array.isArray(r.payload?.attachments) ? r.payload.attachments.length : 0,
    })));
  }

  if (req.method === 'POST') {
    const payload = normaliseSendPayload(req.body || {});
    if (!payload.to.length) return res.status(400).json({ error: 'to is required and must contain at least one valid email' });
    if (!payload.subject) return res.status(400).json({ error: 'subject is required' });
    if (!payload.html && !payload.text) return res.status(400).json({ error: 'html or text body is required' });

    const scheduledFor = req.body?.scheduledFor ? new Date(req.body.scheduledFor) : null;
    if (!scheduledFor || isNaN(scheduledFor.getTime()))
      return res.status(400).json({ error: 'A valid scheduledFor time is required' });
    if (scheduledFor.getTime() <= Date.now())
      return res.status(400).json({ error: 'scheduledFor must be in the future' });

    const id = 'se_' + crypto.randomUUID();
    await sql`
      INSERT INTO scheduled_emails (id, user_email, deal_id, payload, scheduled_for, status)
      VALUES (${id}, ${user.email}, ${payload.dealId}, ${JSON.stringify(payload)}, ${scheduledFor.toISOString()}, 'pending')
    `;
    if (payload.dealId) {
      try {
        await sql`
          INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
          VALUES (
            ${payload.dealId}, 'email_scheduled',
            ${JSON.stringify({ scheduledEmailId: id, subject: payload.subject, to: payload.to, scheduledFor: scheduledFor.toISOString() })},
            ${user.email}
          )
        `;
      } catch (err) {
        console.error('[gmail schedule] deal_events insert failed', err);
      }
    }
    return res.status(201).json({ id, scheduledFor: scheduledFor.toISOString() });
  }

  if (req.method === 'DELETE') {
    const sid = (req.query && req.query.id)
      || new URLSearchParams((req.url || '').split('?')[1] || '').get('id');
    if (!sid) return res.status(400).json({ error: 'id is required' });
    const rows = await sql`
      SELECT payload FROM scheduled_emails
      WHERE id = ${sid} AND user_email = ${user.email} AND status = 'pending'
    `;
    if (!rows.length) return res.status(404).json({ error: 'Scheduled email not found' });
    await sql`UPDATE scheduled_emails SET status = 'cancelled' WHERE id = ${sid} AND user_email = ${user.email}`;
    deleteAttachmentBlobs(rows[0].payload?.attachments || []);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
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
<body><main>${body}<p style="margin-top:18px"><a href="${APP_URL}/" onclick="if(window.opener){window.close();return false;}">Back to Squideo</a></p></main></body></html>`);
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
//
// Returns a diagnostic object so an interactive caller can surface a useful
// reason when the result is null (Gmail returned no sendAs entries, every
// sendAs has an empty signature, the API call 4xx'd, the access token can't
// be refreshed, etc.). Old callers ignore the return.
export async function refreshSignatureCache(userEmail) {
  // Same self-heal as the signature endpoint — refreshSignatureCache is also
  // called from the OAuth callback (where the endpoint guard hasn't run) and
  // from the send path's stale-cache background refresh.
  await ensureSignatureColumns();
  let accessToken;
  try {
    accessToken = await getFreshAccessToken(userEmail);
  } catch (err) {
    console.warn('[gmail signature refresh] token fetch failed', userEmail, err.message);
    return { html: null, summary: [], pickedEmail: null, error: { stage: 'token', message: err.message, code: err.code || null } };
  }
  const result = await fetchGmailSignature(accessToken);
  await sql`
    UPDATE gmail_accounts
       SET signature_html = ${result.html},
           signature_fetched_at = NOW(),
           updated_at = NOW()
     WHERE user_email = ${userEmail}
  `;
  return result;
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
  let refreshToken;
  try {
    refreshToken = decryptToken({
      enc: row.refresh_token_enc,
      iv: row.refresh_token_iv,
      tag: row.refresh_token_tag,
    });
  } catch (err) {
    // The stored token can't be decrypted — almost always because it was
    // encrypted under a previous GMAIL_TOKEN_KEY (key rotation). Treat it
    // exactly like a revoked token: flag the account disconnected so the UI
    // prompts a one-time reconnect rather than surfacing a raw crypto error.
    console.warn('[gmail] token decrypt failed — flagging reconnect', { userEmail, err: err.message });
    await sql`
      UPDATE gmail_accounts
         SET disconnected_at = NOW(), updated_at = NOW()
       WHERE user_email = ${userEmail}
    `;
    const e = new Error('Gmail authorisation expired. Reconnect to continue.');
    e.code = 'REAUTH';
    throw e;
  }
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

// Thin HTTP wrapper around performGmailSend. Validates the request, maps the
// connection errors performGmailSend throws onto HTTP status codes, and after
// a successful immediate send removes any temporary attachment blobs (the
// scheduled-send cron does the same after it fires).
export async function gmailSend(req, res, user) {
  const payload = normaliseSendPayload(req.body || {});
  if (!payload.to.length) return res.status(400).json({ error: 'to is required and must contain at least one valid email' });
  if (!payload.subject) return res.status(400).json({ error: 'subject is required' });
  if (!payload.html && !payload.text) return res.status(400).json({ error: 'html or text body is required' });

  let result;
  try {
    result = await performGmailSend(user, payload);
  } catch (err) {
    if (err.code === 'NOT_CONNECTED' || err.code === 'REAUTH') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    if (err.code === 'GMAIL_SEND_FAILED') {
      return res.status(502).json({ error: err.message });
    }
    throw err;
  }

  deleteAttachmentBlobs(payload.attachments);

  return res.status(200).json({
    ok: true,
    messageId: result.messageId,
    threadId: result.threadId,
    extraDealsLinked: result.extraDealsLinked,
  });
}

// Coerce a raw send payload (from an HTTP body or a stored scheduled_emails
// row) into the canonical shape performGmailSend expects.
export function normaliseSendPayload(body) {
  return {
    to: cleanEmailList(body.to),
    cc: cleanEmailList(body.cc),
    bcc: cleanEmailList(body.bcc),
    subject: trimOrNull(body.subject),
    html: body.html || '',
    text: body.text || '',
    dealId: trimOrNull(body.dealId),
    threadId: trimOrNull(body.gmailThreadId),
    // Extra deals the user wants this email visible on (added via the
    // composer's "Add to another deal" / "Create new deal" menu). We attach
    // them at thread scope, immediately, so the recipient deals show the
    // conversation without waiting for Pub/Sub to deliver it back.
    extraDealIds: Array.isArray(body.extraDealIds)
      ? Array.from(new Set(body.extraDealIds.map(trimOrNull).filter(Boolean)))
      : [],
    // Attachment refs uploaded to Vercel Blob: { blobUrl, filename, mimeType, sizeBytes }.
    attachments: Array.isArray(body.attachments)
      ? body.attachments.filter(a => a && a.blobUrl).map(a => ({
          blobUrl: a.blobUrl,
          blobPathname: a.blobPathname || null,
          filename: a.filename || 'attachment',
          mimeType: a.mimeType || 'application/octet-stream',
          sizeBytes: a.sizeBytes || 0,
        }))
      : [],
  };
}

// Best-effort cleanup of temporary attachment blobs once the message has left
// the box (or been cancelled). Fire-and-forget — a failure just leaves an
// orphan the optional prune cron can sweep later.
function deleteAttachmentBlobs(attachments) {
  for (const a of attachments || []) {
    const target = a.blobUrl || a.blobPathname;
    if (!target) continue;
    Promise.resolve(del(target)).catch((err) =>
      console.warn('[gmail send] attachment blob delete failed', err?.message));
  }
}

// Build a MIME body entity (its own Content-Type header + the body). Used
// either as the whole message body or as the first part inside a
// multipart/mixed when there are attachments.
function buildBodyEntity(htmlOut, textOut) {
  if (htmlOut && textOut) {
    const b = 'sqd_alt_' + crypto.randomBytes(8).toString('hex');
    return `Content-Type: multipart/alternative; boundary="${b}"\r\n\r\n`
      + `--${b}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${textOut}\r\n`
      + `--${b}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${htmlOut}\r\n`
      + `--${b}--\r\n`;
  } else if (htmlOut) {
    return `Content-Type: text/html; charset=UTF-8\r\n\r\n${htmlOut}`;
  }
  return `Content-Type: text/plain; charset=UTF-8\r\n\r\n${textOut}`;
}

// Fetch each attachment blob and render it as a base64 MIME part string.
async function buildAttachmentParts(attachments) {
  const parts = [];
  for (const a of attachments || []) {
    // The blob store is private, so read the bytes through the SDK's get()
    // (it sets the auth header from BLOB_READ_WRITE_TOKEN) rather than a bare
    // fetch, which would 403.
    const result = await get(a.blobUrl, { access: 'private' });
    if (!result || result.statusCode !== 200 || !result.stream) {
      const e = new Error(`Attachment fetch failed for ${a.filename}`);
      e.code = 'GMAIL_SEND_FAILED';
      throw e;
    }
    const buf = Buffer.from(await new Response(result.stream).arrayBuffer());
    const b64 = buf.toString('base64').replace(/(.{76})/g, '$1\r\n');
    const name = (a.filename || 'attachment').replace(/"/g, '');
    parts.push(
      `Content-Type: ${a.mimeType || 'application/octet-stream'}; name="${name}"\r\n`
      + `Content-Disposition: attachment; filename="${name}"\r\n`
      + `Content-Transfer-Encoding: base64\r\n\r\n${b64}`
    );
  }
  return parts;
}

// Core send: resolves a fresh access token, builds the RFC 2822 message
// (optionally multipart/mixed with attachments), POSTs it to Gmail, then logs
// to the deal timeline and eager-persists the message into our own tables.
// Throws errors tagged with .code ('NOT_CONNECTED' | 'REAUTH' | 'GMAIL_SEND_FAILED')
// so both the HTTP wrapper and the scheduled-send cron can react. Callers are
// responsible for cleaning up attachment blobs after a successful send.
export async function performGmailSend(user, payload) {
  const { to, cc, bcc, subject, html, text, dealId, threadId, extraDealIds, attachments } = payload;
  const accessToken = await getFreshAccessToken(user.email);

  // Ensure the signature columns exist before SELECTing them (see comment on
  // ensureSignatureColumns). Otherwise sending an email 500s on workspaces
  // that never applied the migration.
  await ensureSignatureColumns();
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
    if (htmlOut) htmlOut = htmlOut + '<br>' + signatureHtml;
    if (textOut) textOut = textOut + '\n' + signatureHtml.replace(/<[^>]+>/g, '').replace(/\s+\n/g, '\n').trim();
  }

  // Email tracking: instrument the HTML body with an open pixel + click-tracked
  // links. Only HTML emails can be tracked (a pixel needs HTML); text-only
  // sends go out untouched. The token is embedded now; the DB row is written
  // after the send below, once we have the Gmail message/thread ids.
  const trackToken = htmlOut ? newTrackingToken() : null;
  let trackLinks = [];
  if (trackToken) {
    const instrumented = instrumentHtml(htmlOut, trackToken);
    htmlOut = instrumented.html;
    trackLinks = instrumented.links;
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

  // When there are attachments, wrap the body entity (text/html or
  // multipart/alternative) as the first part of a multipart/mixed and append
  // one base64 part per file. With no attachments the body entity's
  // Content-Type just becomes the last header — byte-for-byte the previous
  // multipart/alternative / single-part output.
  const attachmentParts = await buildAttachmentParts(attachments);
  const bodyEntity = buildBodyEntity(htmlOut, textOut);
  let mime;
  if (attachmentParts.length) {
    const mb = 'sqd_mixed_' + crypto.randomBytes(8).toString('hex');
    headers.push(`Content-Type: multipart/mixed; boundary="${mb}"`);
    mime = headers.join('\r\n') + '\r\n\r\n'
      + `--${mb}\r\n` + bodyEntity + '\r\n'
      + attachmentParts.map(p => `--${mb}\r\n${p}\r\n`).join('')
      + `--${mb}--\r\n`;
  } else {
    mime = headers.join('\r\n') + '\r\n' + bodyEntity;
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
    const e = new Error(`Gmail send failed (${sendRes.status})`);
    e.code = 'GMAIL_SEND_FAILED';
    throw e;
  }
  const sent = await sendRes.json();

  // Persist the tracking row now that we have the Gmail ids. Best-effort:
  // recordTrackedSend swallows its own errors so tracking never breaks a send.
  if (trackToken) {
    await recordTrackedSend({
      token: trackToken,
      userEmail: user.email,
      messageId: sent.id,
      threadId: sent.threadId,
      subject,
      recipients: Array.from(new Set([...to, ...cc].filter(Boolean))),
      links: trackLinks,
      source: 'crm',
    });
  }

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
            attachments: attachments.map(a => a.filename),
          })},
          ${user.email}
        )
      `;
      await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${dealId}`;
    } catch (err) {
      console.error('[gmail send] deal_events insert failed', err);
    }
  }

  // Eagerly persist the sent message into our own email_threads /
  // email_messages / email_thread_deals tables so the Emails section on the
  // deal page reflects the send immediately, instead of waiting on Pub/Sub
  // to deliver the message back. Pub/Sub will later upsert the same rows
  // (ON CONFLICT DO NOTHING) so this is purely a head-start.
  if (sent.threadId && sent.id) {
    const participants = Array.from(new Set([fromAddress, ...to, ...cc, ...bcc].filter(Boolean).map(s => s.toLowerCase())));
    const snippetSrc = (text || htmlOut.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const snippet = snippetSrc.slice(0, 200);
    try {
      await sql`
        INSERT INTO email_threads (gmail_thread_id, user_email, subject, last_message_at, participant_emails)
        VALUES (${sent.threadId}, ${user.email}, ${subject}, NOW(), ${participants})
        ON CONFLICT (gmail_thread_id) DO UPDATE SET
          subject = COALESCE(email_threads.subject, EXCLUDED.subject),
          last_message_at = GREATEST(COALESCE(email_threads.last_message_at, '-infinity'::timestamptz), EXCLUDED.last_message_at),
          participant_emails = (
            SELECT COALESCE(array_agg(DISTINCT p), '{}')
            FROM unnest(COALESCE(email_threads.participant_emails, '{}') || EXCLUDED.participant_emails) AS p
          )
      `;
      await sql`
        INSERT INTO email_messages (
          gmail_message_id, gmail_thread_id, user_email,
          from_email, to_emails, cc_emails, subject, snippet,
          body_html, body_text,
          direction, unmatched, internal_only, source, sent_at,
          gmail_attachments
        ) VALUES (
          ${sent.id}, ${sent.threadId}, ${user.email},
          ${fromAddress}, ${to}, ${cc}, ${subject}, ${snippet},
          ${htmlOut ? htmlOut.slice(0, 8 * 1024) : null}, ${textOut ? textOut.slice(0, 8 * 1024) : null},
          'outgoing', ${!dealId}, FALSE, 'compose', NOW(),
          ${attachments.length ? JSON.stringify(attachments.map(a => ({ filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes }))) : null}
        )
        ON CONFLICT (gmail_message_id) DO NOTHING
      `;
      if (dealId) {
        await sql`
          INSERT INTO email_thread_deals (gmail_thread_id, deal_id, resolved_by)
          VALUES (${sent.threadId}, ${dealId}, 'x-header')
          ON CONFLICT (gmail_thread_id, deal_id) DO NOTHING
        `;
      }
      // Attach the conversation to any extra deals the user picked in the
      // composer ("Add to another deal" / "Create new deal").
      for (const extraId of extraDealIds) {
        if (extraId === dealId) continue;
        const dealRow = (await sql`SELECT id FROM deals WHERE id = ${extraId}`)[0];
        if (!dealRow) {
          console.warn('[gmail send] extra deal not found, skipping', extraId);
          continue;
        }
        await sql`
          INSERT INTO email_thread_deals (gmail_thread_id, deal_id, resolved_by)
          VALUES (${sent.threadId}, ${extraId}, 'manual')
          ON CONFLICT (gmail_thread_id, deal_id) DO NOTHING
        `;
        await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${extraId}`;
        await sql`
          INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
          VALUES (
            ${extraId}, 'email_linked',
            ${JSON.stringify({
              gmailThreadId: sent.threadId,
              gmailMessageId: sent.id,
              scope: 'thread',
              source: 'compose',
              primaryDealId: dealId || null,
            })},
            ${user.email}
          )
        `;
      }
    } catch (err) {
      console.error('[gmail send] eager persist failed', err);
      // Don't fail the whole send — the email left the box already; Pub/Sub
      // will catch up later.
    }
  }

  return {
    messageId: sent.id,
    threadId: sent.threadId,
    extraDealsLinked: extraDealIds.length,
  };
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
