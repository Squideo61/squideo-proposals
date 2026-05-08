// Gmail inbound sync: takes a notification (Pub/Sub push or a poll-fallback
// trigger), calls users.history.list from the stored watermark, parses each
// new message, runs the auto-link resolver, and persists everything to
// email_threads / email_messages / email_thread_deals.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import sql from './db.js';

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

// Verify the OIDC JWT that Google attaches to each Pub/Sub push when the
// subscription has authentication enabled. The audience claim defaults to
// the push endpoint URL (which is what we want — we left "Audience" blank
// when creating the subscription).
export async function verifyPushJwt(token, expectedAudience) {
  const { payload } = await jwtVerify(token, GOOGLE_JWKS, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: expectedAudience,
  });
  return payload;
}

// Decode a Pub/Sub push body. The shape is:
//   { message: { data: "<base64>", messageId, publishTime }, subscription }
// where `data` decodes to JSON like { emailAddress, historyId }.
export function parsePushBody(body) {
  const data = body?.message?.data;
  if (!data) return null;
  try {
    const decoded = Buffer.from(data, 'base64').toString('utf8');
    const json = JSON.parse(decoded);
    if (!json.emailAddress || !json.historyId) return null;
    return {
      emailAddress: String(json.emailAddress).toLowerCase(),
      historyId: String(json.historyId),
    };
  } catch {
    return null;
  }
}

// Pull every message added since `fromHistoryId` and ingest each one. Stops
// when Gmail tells us there are no more pages. Returns the count ingested
// and the final historyId we should advance the watermark to.
export async function syncHistory({ userEmail, accessToken, fromHistoryId }) {
  let pageToken = null;
  let latestHistoryId = fromHistoryId;
  const seen = new Set();
  let ingested = 0;
  let pages = 0;

  // Hard cap to keep us inside Vercel's 60s function budget. ~10 pages of
  // 100 events each is plenty for one push; if more events arrived, the
  // next push (or the poll-fallback cron) picks up where we leave off.
  const MAX_PAGES = 10;

  do {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
    url.searchParams.set('startHistoryId', String(fromHistoryId));
    url.searchParams.set('historyTypes', 'messageAdded');
    url.searchParams.set('maxResults', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    if (res.status === 404) {
      // Watermark is too old — Gmail has dropped that history. Caller should
      // re-register the watch and reset the watermark to whatever the watch
      // returns.
      throw Object.assign(new Error('history watermark expired'), { code: 'HISTORY_GONE' });
    }
    if (!res.ok) {
      throw new Error(`history.list failed (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    if (data.historyId) latestHistoryId = String(data.historyId);

    for (const entry of (data.history || [])) {
      for (const added of (entry.messagesAdded || [])) {
        const id = added?.message?.id;
        if (id && !seen.has(id)) {
          seen.add(id);
          try {
            await ingestMessage({ userEmail, accessToken, messageId: id });
            ingested++;
          } catch (err) {
            console.error('[gmail sync] ingest failed', { messageId: id, err: err.message });
          }
        }
      }
    }

    pageToken = data.nextPageToken || null;
    pages++;
  } while (pageToken && pages < MAX_PAGES);

  return { ingested, latestHistoryId, more: !!pageToken };
}

// Fetch a single Gmail message in 'full' format, parse it, run the auto-link
// resolver, and write to email_threads + email_messages + email_thread_deals.
// Idempotent on gmail_message_id and on (gmail_thread_id, deal_id).
export async function ingestMessage({ userEmail, accessToken, messageId }) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set('format', 'full');

  const res = await fetch(url.toString(), {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (res.status === 404) return null; // Deleted before we got there
  if (!res.ok) throw new Error(`messages.get failed (${res.status}): ${await res.text()}`);
  const msg = await res.json();

  const headers = parseHeaders(msg.payload?.headers || []);
  const fromEmail = extractEmail(headers.from);
  const toEmails = parseAddressList(headers.to);
  const ccEmails = parseAddressList(headers.cc);
  const subject = headers.subject || '';
  const messageIdHeader = unwrapAngled(headers['message-id']);
  const inReplyTo = unwrapAngled(headers['in-reply-to']);
  const refs = (headers.references || '').split(/\s+/).map(unwrapAngled).filter(Boolean);
  const xSquideoDeal = headers['x-squideo-deal'] || null;
  const sentAt = headers.date
    ? new Date(headers.date).toISOString()
    : new Date(Number(msg.internalDate || Date.now())).toISOString();
  const snippet = msg.snippet || '';

  const acct = (await sql`SELECT gmail_address FROM gmail_accounts WHERE user_email = ${userEmail}`)[0];
  const myAddress = (acct?.gmail_address || userEmail).toLowerCase();
  const direction = (fromEmail && fromEmail.toLowerCase() === myAddress) ? 'outbound' : 'inbound';

  // Internal-only filter: every participant is one of our team members.
  const allAddresses = Array.from(new Set([fromEmail, ...toEmails, ...ccEmails]
    .filter(Boolean).map(s => s.toLowerCase())));
  let internalOnly = false;
  if (allAddresses.length > 1) {
    const internalRows = await sql`
      SELECT LOWER(email) AS email FROM users WHERE LOWER(email) = ANY(${allAddresses})
    `;
    const internalSet = new Set(internalRows.map(r => r.email));
    internalOnly = allAddresses.every(a => internalSet.has(a));
  }

  const { html, text } = extractBody(msg.payload);

  const participants = allAddresses;

  // Upsert thread first so the FK is satisfied.
  await sql`
    INSERT INTO email_threads (gmail_thread_id, user_email, subject, last_message_at, participant_emails)
    VALUES (${msg.threadId}, ${userEmail}, ${subject || null}, ${sentAt}, ${participants})
    ON CONFLICT (gmail_thread_id) DO UPDATE SET
      subject = COALESCE(email_threads.subject, EXCLUDED.subject),
      last_message_at = GREATEST(COALESCE(email_threads.last_message_at, '-infinity'::timestamptz), EXCLUDED.last_message_at),
      participant_emails = (
        SELECT COALESCE(array_agg(DISTINCT p), '{}')
        FROM unnest(COALESCE(email_threads.participant_emails, '{}') || EXCLUDED.participant_emails) AS p
      )
  `;

  // Auto-link resolver (rules in priority order).
  const resolved = await resolveDealForMessage({
    userEmail,
    threadId: msg.threadId,
    fromEmail,
    toEmails,
    ccEmails,
    inReplyTo,
    refs,
    xSquideoDeal,
    internalOnly,
  });

  await sql`
    INSERT INTO email_messages (
      gmail_message_id, gmail_thread_id, user_email,
      message_id_header, in_reply_to, refs,
      from_email, to_emails, cc_emails, subject, snippet,
      body_html, body_text,
      direction, unmatched, internal_only, source, sent_at
    ) VALUES (
      ${messageId}, ${msg.threadId}, ${userEmail},
      ${messageIdHeader || null}, ${inReplyTo || null}, ${refs},
      ${fromEmail || null}, ${toEmails}, ${ccEmails}, ${subject || null}, ${snippet || null},
      ${html ? html.slice(0, 8 * 1024) : null}, ${text ? text.slice(0, 8 * 1024) : null},
      ${direction}, ${!resolved.dealId}, ${internalOnly}, 'pubsub', ${sentAt}
    )
    ON CONFLICT (gmail_message_id) DO NOTHING
  `;

  if (resolved.dealId) {
    await sql`
      INSERT INTO email_thread_deals (gmail_thread_id, deal_id, resolved_by)
      VALUES (${msg.threadId}, ${resolved.dealId}, ${resolved.resolvedBy})
      ON CONFLICT (gmail_thread_id, deal_id) DO NOTHING
    `;
    await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${resolved.dealId}`;
  }

  return { messageId, threadId: msg.threadId, dealId: resolved.dealId, resolvedBy: resolved.resolvedBy };
}

// Auto-link rules in priority order. Returns { dealId, resolvedBy } or
// { dealId: null } if no match.
async function resolveDealForMessage({
  userEmail, threadId, fromEmail, toEmails, ccEmails, inReplyTo, refs, xSquideoDeal, internalOnly,
}) {
  // Internal team-only — don't auto-link, but also don't leave it unmatched.
  // We'll mark it internal_only=true (no deal); the UI will hide these.
  if (internalOnly) return { dealId: null, resolvedBy: null };

  // 1. X-Squideo-Deal header injected by our compose helper or extension.
  if (xSquideoDeal) {
    const exists = await sql`SELECT id FROM deals WHERE id = ${xSquideoDeal}`;
    if (exists.length) return { dealId: exists[0].id, resolvedBy: 'header' };
  }

  // 2. Thread continuity — already linked to a deal? Use that.
  const threadLink = await sql`SELECT deal_id FROM email_thread_deals WHERE gmail_thread_id = ${threadId} LIMIT 1`;
  if (threadLink.length) return { dealId: threadLink[0].deal_id, resolvedBy: 'thread' };

  // 3. In-Reply-To / References — look up the parent message and inherit its deal.
  const parentRefs = [inReplyTo, ...refs].filter(Boolean);
  if (parentRefs.length) {
    const parents = await sql`
      SELECT etd.deal_id
      FROM email_messages em
      JOIN email_thread_deals etd ON etd.gmail_thread_id = em.gmail_thread_id
      WHERE em.message_id_header = ANY(${parentRefs})
      LIMIT 1
    `;
    if (parents.length) return { dealId: parents[0].deal_id, resolvedBy: 'in-reply-to' };
  }

  // 4. Contact email match — pick the most recently active deal that has
  //    this contact attached (either as primary, or via deal_contacts).
  const otherEmails = [fromEmail, ...toEmails, ...ccEmails]
    .filter(Boolean)
    .map(s => s.toLowerCase())
    .filter(e => e !== (userEmail || '').toLowerCase());
  if (otherEmails.length) {
    const contactMatch = await sql`
      WITH matched_contacts AS (
        SELECT id FROM contacts WHERE LOWER(email) = ANY(${otherEmails})
      )
      SELECT d.id, d.last_activity_at
      FROM deals d
      WHERE d.stage <> 'lost'
        AND (
          d.primary_contact_id IN (SELECT id FROM matched_contacts)
          OR EXISTS (
            SELECT 1 FROM deal_contacts dc
            WHERE dc.deal_id = d.id AND dc.contact_id IN (SELECT id FROM matched_contacts)
          )
        )
      ORDER BY d.last_activity_at DESC
      LIMIT 1
    `;
    if (contactMatch.length) return { dealId: contactMatch[0].id, resolvedBy: 'contact' };

    // 5. Domain match — fall back to companies.domain on a non-team email.
    const domains = otherEmails.map(e => e.split('@')[1]).filter(Boolean);
    if (domains.length) {
      const domainMatch = await sql`
        SELECT d.id
        FROM deals d
        JOIN companies c ON c.id = d.company_id
        WHERE d.stage <> 'lost'
          AND LOWER(c.domain) = ANY(${domains.map(d => d.toLowerCase())})
        ORDER BY d.last_activity_at DESC
        LIMIT 1
      `;
      if (domainMatch.length) return { dealId: domainMatch[0].id, resolvedBy: 'domain' };
    }
  }

  return { dealId: null, resolvedBy: null };
}

// ---------- Header / body parsing helpers ----------

function parseHeaders(arr) {
  const out = {};
  for (const h of arr) out[String(h.name || '').toLowerCase()] = h.value || '';
  return out;
}

function extractEmail(value) {
  if (!value) return null;
  // "Name <addr@ex.com>" or just "addr@ex.com"
  const m = String(value).match(/<([^>]+)>/);
  if (m) return m[1].trim();
  const trimmed = String(value).trim();
  return /@/.test(trimmed) ? trimmed : null;
}

function parseAddressList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map(extractEmail)
    .filter(Boolean);
}

function unwrapAngled(value) {
  if (!value) return null;
  const m = String(value).trim().match(/^<(.+)>$/);
  return (m ? m[1] : String(value).trim()) || null;
}

// Walks the MIME tree and returns { html, text }. Prefers the first text/html
// and text/plain parts at any depth.
function extractBody(payload) {
  let html = null;
  let text = null;

  const walk = (part) => {
    if (!part) return;
    const mime = part.mimeType || '';
    if (mime === 'text/html' && !html && part.body?.data) {
      html = decodeBase64Url(part.body.data);
    } else if (mime === 'text/plain' && !text && part.body?.data) {
      text = decodeBase64Url(part.body.data);
    }
    if (Array.isArray(part.parts)) {
      for (const p of part.parts) walk(p);
    }
  };
  walk(payload);
  return { html, text };
}

function decodeBase64Url(s) {
  try {
    return Buffer.from(s, 'base64url').toString('utf8');
  } catch {
    try { return Buffer.from(s, 'base64').toString('utf8'); }
    catch { return null; }
  }
}
