// Live Gmail proxy for the Emails section's mailbox folders (Inbox, Sent,
// Drafts, Spam, Trash, Starred, All Mail). Unlike the Deals/Triage folders —
// which read our own email_messages table — these folders are fetched on
// demand straight from the Gmail REST API so they always mirror Gmail exactly
// without us mass-storing the whole mailbox.
//
// Conversation-centric, like Gmail: folders list one row per THREAD
// (users.threads.list + a metadata threads.get per thread), opening a row
// returns the whole conversation (threads.get?format=full), and actions are
// applied at thread scope (threads.modify / trash / untrash).
//
// All routes are reached via the existing `gmail` resource (e.g.
// /api/crm/gmail/folder) — gmailRoute delegates here — so they inherit the
// proven 2-segment routing and the dispatcher's requireAuth.
import { getFreshAccessToken } from './gmail.js';
import { actionToLabels } from './mailboxLabels.js';
import { trackingForThreads } from './tracking.js';
import {
  extractBody,
  extractAttachments,
  parseHeaders,
  extractEmail,
  parseAddressList,
} from '../gmailSync.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PAGE_SIZE = 40;

// Folder id (from the UI) → Gmail label. 'all' (All Mail) applies no label
// filter; 'deals' and 'triage' are DB-backed and never reach this module.
const FOLDER_LABELS = {
  inbox: 'INBOX',
  unread: 'UNREAD',
  sent: 'SENT',
  drafts: 'DRAFT',
  starred: 'STARRED',
  spam: 'SPAM',
  trash: 'TRASH',
  all: null,
  // Gmail's smart categories — only surfaced in the UI when the account uses
  // them. A single category label behaves like any other folder here.
  social: 'CATEGORY_SOCIAL',
  updates: 'CATEGORY_UPDATES',
  forums: 'CATEGORY_FORUMS',
  promotions: 'CATEGORY_PROMOTIONS',
};

function qp(req, key) {
  if (req.query && req.query[key] != null) return req.query[key];
  return new URLSearchParams((req.url || '').split('?')[1] || '').get(key);
}

// Gmail returns `snippet` HTML-escaped (e.g. "I&#39;m", "&amp;"). Decode the
// common named + numeric entities so the CRM shows real punctuation, not markup.
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  if (!s) return s;
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const named = NAMED_ENTITIES[ent.toLowerCase()];
    return named != null ? named : m;
  });
}

// Thin wrapper around the Gmail REST API. `path` is relative to GMAIL_API.
// Throws an error tagged GMAIL_API_FAILED on a non-2xx so mailboxLive maps it
// to a 502 rather than leaking Gmail's raw response.
async function gmailFetch(accessToken, path, init = {}) {
  const res = await fetch(GMAIL_API + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + accessToken,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const e = new Error(`Gmail API ${path} failed (${res.status})`);
    e.code = 'GMAIL_API_FAILED';
    e.status = res.status;
    e.detail = detail;
    throw e;
  }
  return res;
}

export async function mailboxLive(req, res, id, user) {
  let accessToken;
  try {
    accessToken = await getFreshAccessToken(user.email);
  } catch (err) {
    if (err.code === 'NOT_CONNECTED' || err.code === 'REAUTH') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  try {
    if (id === 'folder')     return await listFolder(req, res, accessToken, user);
    if (id === 'thread')     return await getThread(req, res, accessToken, user);
    if (id === 'attachment') return await getAttachment(req, res, accessToken);
    if (id === 'modify')     return await modifyThreads(req, res, accessToken);
    if (id === 'labels')     return await listLabelCounts(req, res, accessToken);
  } catch (err) {
    if (err.code === 'GMAIL_API_FAILED') {
      console.error('[mailbox]', id, err.status, err.detail);
      return res.status(502).json({ error: 'Gmail API error', code: 'GMAIL_API_FAILED' });
    }
    throw err;
  }
  return res.status(404).json({ error: 'Unknown mailbox action: ' + id });
}

// GET /api/crm/gmail/folder?label=inbox&pageToken=&q=
// Lists a page of threads for the folder, then fetches lightweight metadata
// per thread in parallel to build the conversation summary rows.
async function listFolder(req, res, accessToken, user) {
  if (req.method !== 'GET') return res.status(405).end();
  const folder = String(qp(req, 'label') || 'inbox').toLowerCase();
  if (!(folder in FOLDER_LABELS)) return res.status(400).json({ error: 'Unknown folder: ' + folder });
  const label = FOLDER_LABELS[folder];
  const pageToken = qp(req, 'pageToken');
  const q = qp(req, 'q');
  const unreadOnly = qp(req, 'unread') === '1';

  const params = new URLSearchParams();
  params.set('maxResults', String(PAGE_SIZE));
  // A search query behaves like Gmail's own search box: it spans the whole
  // mailbox, not just the current folder. So when q is present we drop the
  // folder label entirely (otherwise searching from Inbox would never find
  // archived mail or anything outside Inbox). Without a query we filter to the
  // folder's label as usual.
  if (label && !q) params.append('labelIds', label);
  // "Unread only" filter: Gmail ANDs multiple labelIds, so adding UNREAD
  // narrows any folder/category to its unread threads without pulling in
  // Spam/Trash (which the q-based path would).
  if (unreadOnly && label !== 'UNREAD') params.append('labelIds', 'UNREAD');
  if (q) params.set('q', q);
  if (pageToken) params.set('pageToken', pageToken);
  // Spam/Trash are excluded from list results unless we opt in; All Mail and
  // explicit searches should see everything.
  if (label === 'SPAM' || label === 'TRASH' || folder === 'all' || q) {
    params.set('includeSpamTrash', 'true');
  }

  const listJson = await (await gmailFetch(accessToken, '/threads?' + params.toString())).json();
  const ids = (listJson.threads || []).map(t => t.id);

  const rows = await Promise.all(ids.map(async (tid) => {
    const t = await (await gmailFetch(
      accessToken,
      `/threads/${encodeURIComponent(tid)}?format=metadata`
        + '&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date'
        + '&metadataHeaders=Content-Type',
    )).json();
    return summariseThread(t);
  }));

  // Attach Streak-style open/click tracking for any of these threads the user
  // sent through us. Best-effort — failures degrade to no tracking.
  if (user?.email && rows.length) {
    const tracking = await trackingForThreads(user.email, rows.map(r => r.id));
    for (const r of rows) if (tracking[r.id]) r.tracking = tracking[r.id];
  }

  return res.status(200).json({
    rows,
    nextPageToken: listJson.nextPageToken || null,
  });
}

// Build a conversation-summary row from a metadata threads.get response.
function summariseThread(t) {
  const msgs = t.messages || [];
  const first = msgs[0] || {};
  const last = msgs[msgs.length - 1] || {};
  const firstH = parseHeaders(first.payload?.headers || []);
  const lastH = parseHeaders(last.payload?.headers || []);
  const labelIds = new Set();
  const senders = [];
  let hasAttachments = false;
  for (const m of msgs) {
    for (const l of (m.labelIds || [])) labelIds.add(l);
    const name = displayNameOrEmail(parseHeaders(m.payload?.headers || []).from);
    if (name && !senders.includes(name)) senders.push(name);
    if (!hasAttachments && messageHasAttachment(m)) hasAttachments = true;
  }
  return {
    id: t.id,
    threadId: t.id,
    subject: firstH.subject || lastH.subject || null,
    from: lastH.from || null,
    fromEmail: extractEmail(lastH.from),
    participants: senders,
    snippet: decodeEntities(last.snippet || t.snippet || ''),
    date: headerDate(lastH.date, last.internalDate),
    messageCount: msgs.length,
    hasAttachments,
    unread: msgs.some(m => (m.labelIds || []).includes('UNREAD')),
    starred: msgs.some(m => (m.labelIds || []).includes('STARRED')),
    labelIds: Array.from(labelIds),
  };
}

// Does a metadata message carry a real (downloadable) attachment? Prefer the
// MIME tree (a part with a filename + attachmentId); fall back to a
// multipart/mixed top-level Content-Type when the metadata payload omits the
// part bodies. Inline images (multipart/related) deliberately don't count.
function messageHasAttachment(m) {
  if (extractAttachments(m.payload).length > 0) return true;
  const ct = parseHeaders(m.payload?.headers || [])['content-type'] || '';
  return /multipart\/mixed/i.test(ct);
}

// GET /api/crm/gmail/thread?id=<threadId> — the full conversation.
async function getThread(req, res, accessToken, user) {
  if (req.method !== 'GET') return res.status(405).end();
  const tid = qp(req, 'id');
  if (!tid) return res.status(400).json({ error: 'id required' });

  const t = await (await gmailFetch(accessToken, `/threads/${encodeURIComponent(tid)}?format=full`)).json();
  const messages = (t.messages || []).map((m) => {
    const h = parseHeaders(m.payload?.headers || []);
    const { html, text } = extractBody(m.payload);
    const labelIds = m.labelIds || [];
    return {
      id: m.id,
      from: h.from || null,
      fromEmail: extractEmail(h.from),
      to: parseAddressList(h.to),
      cc: parseAddressList(h.cc),
      subject: h.subject || null,
      date: headerDate(h.date, m.internalDate),
      snippet: decodeEntities(m.snippet || ''),
      html: html || null,
      text: text || null,
      attachments: extractAttachments(m.payload),
      labelIds,
      unread: labelIds.includes('UNREAD'),
      outbound: false, // the client decides direction against the account address
    };
  });
  let tracking = null;
  if (user?.email) {
    const map = await trackingForThreads(user.email, [t.id]);
    tracking = map[t.id] || null;
  }
  return res.status(200).json({
    id: t.id,
    threadId: t.id,
    subject: messages[0]?.subject || null,
    messages,
    tracking,
  });
}

// GET /api/crm/gmail/attachment?messageId=&attachmentId=&filename=&mimeType=
// Streams the decoded attachment bytes back to the browser as a download.
async function getAttachment(req, res, accessToken) {
  if (req.method !== 'GET') return res.status(405).end();
  const messageId = qp(req, 'messageId');
  const attachmentId = qp(req, 'attachmentId');
  if (!messageId || !attachmentId) return res.status(400).json({ error: 'messageId and attachmentId required' });
  const filename = (qp(req, 'filename') || 'attachment').replace(/"/g, '');
  const mimeType = qp(req, 'mimeType') || 'application/octet-stream';

  const j = await (await gmailFetch(
    accessToken,
    `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  )).json();
  const buf = Buffer.from(j.data || '', 'base64url');
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(buf.length));
  return res.status(200).end(buf);
}

// POST /api/crm/gmail/modify  { action, ids: [threadId, ...] }
// Applies the action to whole conversations (Gmail's own behaviour — archiving
// a conversation archives every message in it).
async function modifyThreads(req, res, accessToken) {
  if (req.method !== 'POST') return res.status(405).end();
  const { action, ids } = req.body || {};
  const idList = Array.isArray(ids) ? ids.filter(Boolean) : (ids ? [ids] : []);
  if (!idList.length) return res.status(400).json({ error: 'ids required' });
  const map = actionToLabels(action);
  if (!map) return res.status(400).json({ error: 'Unknown action: ' + action });

  const op = map.trash ? 'trash' : map.untrash ? 'untrash' : null;
  const run = (tid) => op
    ? gmailFetch(accessToken, `/threads/${encodeURIComponent(tid)}/${op}`, { method: 'POST' })
    // threads.modify has no batch form — apply the label delta per thread.
    : gmailFetch(accessToken, `/threads/${encodeURIComponent(tid)}/modify`, {
        method: 'POST',
        body: JSON.stringify({ addLabelIds: map.add || [], removeLabelIds: map.remove || [] }),
      });

  // Gmail rate-limits bursts (threads.modify costs 10 quota units; the per-user
  // ceiling is ~250/sec). Firing all ids at once made large bulk actions 429
  // and fail wholesale, so cap concurrency and retry transient errors. Only a
  // total failure is surfaced as an error — partial success still 200s.
  const failed = await runBatched(idList, 5, (tid) => withRetry(() => run(tid)));
  if (failed.length === idList.length) {
    const e = new Error('Gmail bulk modify failed');
    e.code = 'GMAIL_API_FAILED';
    throw e;
  }
  return res.status(200).json({ ok: true, modified: idList.length - failed.length, failed: failed.length });
}

// Retry a Gmail call on transient errors (rate limit / 5xx) with backoff.
async function withRetry(fn, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const status = err?.status;
      if (status !== 429 && status !== 500 && status !== 503) break; // non-transient
      await new Promise(r => setTimeout(r, 250 * 2 ** i + Math.random() * 150));
    }
  }
  throw lastErr;
}

// Run `fn` over items with a concurrency cap. Returns the items that failed
// (all attempts exhausted) so the caller can decide whether to surface an error.
async function runBatched(items, limit, fn) {
  const failed = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const results = await Promise.allSettled(chunk.map(fn));
    results.forEach((r, j) => { if (r.status === 'rejected') failed.push(chunk[j]); });
  }
  return failed;
}

// GET /api/crm/gmail/labels — unread/total counts for the sidebar badges.
async function listLabelCounts(req, res, accessToken) {
  if (req.method !== 'GET') return res.status(405).end();
  const wanted = ['INBOX', 'UNREAD', 'SPAM', 'DRAFT',
    'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'CATEGORY_PROMOTIONS'];
  const out = {};
  await Promise.all(wanted.map(async (lbl) => {
    try {
      const j = await (await gmailFetch(accessToken, `/labels/${lbl}`)).json();
      out[lbl] = {
        unread: j.messagesUnread ?? 0,
        total: j.messagesTotal ?? 0,
        threadsUnread: j.threadsUnread ?? 0,
        threadsTotal: j.threadsTotal ?? 0,
      };
    } catch {
      out[lbl] = { unread: 0, total: 0, threadsUnread: 0, threadsTotal: 0 };
    }
  }));
  return res.status(200).json(out);
}

// "John Doe" from `John Doe <a@b.com>`, else the bare address, else null.
function displayNameOrEmail(fromHeader) {
  if (!fromHeader) return null;
  const m = String(fromHeader).match(/^\s*"?([^"<]+?)"?\s*<.+>/);
  if (m) return m[1].trim();
  return extractEmail(fromHeader) || String(fromHeader).trim() || null;
}

function headerDate(dateHeader, internalDate) {
  if (dateHeader) {
    const t = new Date(dateHeader);
    if (!isNaN(t.getTime())) return t.toISOString();
  }
  if (internalDate) return new Date(Number(internalDate)).toISOString();
  return null;
}
