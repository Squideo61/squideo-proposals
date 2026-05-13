import sql from '../db.js';
import { APP_URL } from '../email.js';
import { registerWatch } from '../gmailTokens.js';
import { verifyPushJwt, parsePushBody, syncHistory } from '../gmailSync.js';
import { getFreshAccessToken } from './gmail.js';

// Pub/Sub push receiver. Google calls this whenever the user has new Gmail
// activity. We verify the OIDC JWT, look up the account by gmail_address,
// fetch every messageAdded event since our stored historyId watermark, and
// run each one through the auto-link resolver.
export async function gmailPush(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Verify Google's signed JWT. Failing this means someone is forging a
  // push — we 401 without doing any work.
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
    console.warn('[gmail push] missing bearer token', { ip });
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  const token = authHeader.slice(7);
  const expectedAudience = process.env.GMAIL_PUSH_AUDIENCE
    || `${APP_URL.replace(/\/$/, '')}/api/crm/gmail/push`;
  try {
    await verifyPushJwt(token, expectedAudience);
  } catch (err) {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
    console.warn('[gmail push] JWT verification failed', { ip, err: err.message });
    return res.status(401).json({ error: 'Invalid JWT' });
  }

  // Parse the Pub/Sub envelope. Always 200 so Pub/Sub doesn't retry on
  // malformed data — we'd just keep failing.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const decoded = parsePushBody(body || {});
  if (!decoded) {
    return res.status(200).json({ ok: true, skip: 'malformed' });
  }
  const { emailAddress, historyId } = decoded;

  // Find the account this notification is for.
  const accounts = await sql`
    SELECT user_email, history_id
    FROM gmail_accounts
    WHERE LOWER(gmail_address) = ${emailAddress} AND disconnected_at IS NULL
  `;
  if (!accounts.length) {
    // Could be an account that disconnected — silently ack.
    return res.status(200).json({ ok: true, skip: 'no-account' });
  }
  const account = accounts[0];

  await sql`
    UPDATE gmail_accounts SET last_pushed_at = NOW(), updated_at = NOW()
    WHERE user_email = ${account.user_email}
  `;

  // First push for this account (no watermark yet) — adopt the historyId
  // and skip processing. Future pushes will sync from here forward.
  if (!account.history_id) {
    await sql`
      UPDATE gmail_accounts SET history_id = ${historyId} WHERE user_email = ${account.user_email}
    `;
    return res.status(200).json({ ok: true, skip: 'first-push' });
  }

  // Sync all messageAdded events between our watermark and the new historyId.
  let accessToken;
  try {
    accessToken = await getFreshAccessToken(account.user_email);
  } catch (err) {
    console.error('[gmail push] token refresh failed', err.message);
    // Account is broken — ack so Pub/Sub doesn't retry forever.
    return res.status(200).json({ ok: false, error: 'token-refresh-failed' });
  }

  try {
    const result = await syncHistory({
      userEmail: account.user_email,
      accessToken,
      fromHistoryId: account.history_id,
    });
    await sql`
      UPDATE gmail_accounts SET history_id = ${result.latestHistoryId}, updated_at = NOW()
      WHERE user_email = ${account.user_email}
    `;
    return res.status(200).json({ ok: true, ingested: result.ingested, more: result.more });
  } catch (err) {
    if (err.code === 'HISTORY_GONE') {
      // Watermark fell off Gmail's history retention. Reset by re-issuing
      // the watch and adopting whatever historyId it returns.
      console.warn('[gmail push] history gone, re-issuing watch', { user: account.user_email });
      try {
        const watch = await registerWatch(accessToken, process.env.GMAIL_PUBSUB_TOPIC);
        await sql`
          UPDATE gmail_accounts SET
            history_id = ${watch.historyId},
            watch_expires_at = ${watch.expiration ? new Date(watch.expiration).toISOString() : null},
            updated_at = NOW()
          WHERE user_email = ${account.user_email}
        `;
      } catch (renewErr) {
        console.error('[gmail push] watch renew after HISTORY_GONE failed', renewErr.message);
      }
      return res.status(200).json({ ok: true, recovered: 'history-gone' });
    }
    console.error('[gmail push] sync failed', err);
    // Ack so Pub/Sub doesn't retry — the next push (or the poll-fallback
    // cron) will pick up where we left off.
    return res.status(200).json({ ok: false, error: err.message });
  }
}
