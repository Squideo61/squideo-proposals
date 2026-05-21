// Live Gmail proxy for the Emails section's mailbox folders (Inbox, Sent,
// Drafts, Spam, Trash, Starred, All Mail). Unlike the Deals/Triage folders —
// which read our own email_messages table — these folders are fetched on
// demand straight from the Gmail REST API so they always mirror Gmail exactly
// without us mass-storing the whole mailbox. Reuses getFreshAccessToken (token
// refresh, with REAUTH handling) and the MIME parsers from gmailSync.js.
//
// All routes are reached via the existing `gmail` resource (e.g.
// /api/crm/gmail/folder) — gmailRoute delegates here — so they inherit the
// proven 2-segment routing and the dispatcher's requireAuth.
import { getFreshAccessToken } from './gmail.js';
import { actionToLabels } from './mailboxLabels.js';
import {
  extractBody,
  extractAttachments,
  parseHeaders,
  extractEmail,
  parseAddressList,
} from '../gmailSync.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PAGE_SIZE = 25;

// Folder id (from the UI) → Gmail label. 'all' (All Mail) applies no label
// filter; 'deals' and 'triage' are DB-backed and never reach this module.
const FOLDER_LABELS = {
  inbox: 'INBOX',
  sent: 'SENT',
  drafts: 'DRAFT',
  starred: 'STARRED',
  spam: 'SPAM',
  trash: 'TRASH',
  all: null,
};

function qp(req, key) {
  if (req.query && req.query[key] != null) return req.query[key];
  return new URLSearchParams((req.url || '').split('?')[1] || '').get(key);
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
    if (id === 'folder')     return await listFolder(req, res, accessToken);
    if (id === 'message')    return await getMessage(req, res, accessToken);
    if (id === 'attachment') return await getAttachment(req, res, accessToken);
    if (id === 'modify')     return await modifyMessages(req, res, accessToken);
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
// Lists a page of messages for the folder, then fetches lightweight metadata
// (From/To/Subject/Date + labels) per id in parallel to build the rows.
async function listFolder(req, res, accessToken) {
  if (req.method !== 'GET') return res.status(405).end();
  const folder = String(qp(req, 'label') || 'inbox').toLowerCase();
  if (!(folder in FOLDER_LABELS)) return res.status(400).json({ error: 'Unknown folder: ' + folder });
  const label = FOLDER_LABELS[folder];
  const pageToken = qp(req, 'pageToken');
  const q = qp(req, 'q');

  const params = new URLSearchParams();
  params.set('maxResults', String(PAGE_SIZE));
  if (label) params.set('labelIds', label);
  if (q) params.set('q', q);
  if (pageToken) params.set('pageToken', pageToken);
  // Spam/Trash are excluded from list results unless we opt in; All Mail and
  // explicit searches should see everything.
  if (label === 'SPAM' || label === 'TRASH' || folder === 'all' || q) {
    params.set('includeSpamTrash', 'true');
  }

  const listJson = await (await gmailFetch(accessToken, '/messages?' + params.toString())).json();
  const ids = (listJson.messages || []).map(m => m.id);

  const rows = await Promise.all(ids.map(async (mid) => {
    const m = await (await gmailFetch(
      accessToken,
      `/messages/${encodeURIComponent(mid)}?format=metadata`
        + '&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date',
    )).json();
    const h = parseHeaders(m.payload?.headers || []);
    const labelIds = m.labelIds || [];
    return {
      id: m.id,
      threadId: m.threadId,
      from: h.from || null,
      fromEmail: extractEmail(h.from),
      to: h.to || null,
      subject: h.subject || null,
      snippet: m.snippet || '',
      date: headerDate(h.date, m.internalDate),
      labelIds,
      unread: labelIds.includes('UNREAD'),
      starred: labelIds.includes('STARRED'),
    };
  }));

  return res.status(200).json({
    rows,
    nextPageToken: listJson.nextPageToken || null,
  });
}

// GET /api/crm/gmail/message?id=<gmailMessageId> — one full message.
async function getMessage(req, res, accessToken) {
  if (req.method !== 'GET') return res.status(405).end();
  const mid = qp(req, 'id');
  if (!mid) return res.status(400).json({ error: 'id required' });

  const m = await (await gmailFetch(accessToken, `/messages/${encodeURIComponent(mid)}?format=full`)).json();
  const h = parseHeaders(m.payload?.headers || []);
  const { html, text } = extractBody(m.payload);
  const attachments = extractAttachments(m.payload);

  return res.status(200).json({
    id: m.id,
    threadId: m.threadId,
    from: h.from || null,
    fromEmail: extractEmail(h.from),
    to: parseAddressList(h.to),
    cc: parseAddressList(h.cc),
    subject: h.subject || null,
    date: headerDate(h.date, m.internalDate),
    snippet: m.snippet || '',
    html: html || null,
    text: text || null,
    labelIds: m.labelIds || [],
    attachments,
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

// POST /api/crm/gmail/modify  { action, ids: [] }
async function modifyMessages(req, res, accessToken) {
  if (req.method !== 'POST') return res.status(405).end();
  const { action, ids } = req.body || {};
  const idList = Array.isArray(ids) ? ids.filter(Boolean) : (ids ? [ids] : []);
  if (!idList.length) return res.status(400).json({ error: 'ids required' });
  const map = actionToLabels(action);
  if (!map) return res.status(400).json({ error: 'Unknown action: ' + action });

  if (map.trash || map.untrash) {
    // No batch endpoint for trash/untrash — fire them in parallel.
    const op = map.trash ? 'trash' : 'untrash';
    await Promise.all(idList.map(mid =>
      gmailFetch(accessToken, `/messages/${encodeURIComponent(mid)}/${op}`, { method: 'POST' })));
    return res.status(200).json({ ok: true });
  }

  // batchModify applies the label delta to up to 1000 ids in one call (204).
  await gmailFetch(accessToken, '/messages/batchModify', {
    method: 'POST',
    body: JSON.stringify({
      ids: idList,
      addLabelIds: map.add || [],
      removeLabelIds: map.remove || [],
    }),
  });
  return res.status(200).json({ ok: true });
}

// GET /api/crm/gmail/labels — unread/total counts for the sidebar badges.
async function listLabelCounts(req, res, accessToken) {
  if (req.method !== 'GET') return res.status(405).end();
  const wanted = ['INBOX', 'SPAM', 'DRAFT'];
  const out = {};
  await Promise.all(wanted.map(async (lbl) => {
    try {
      const j = await (await gmailFetch(accessToken, `/labels/${lbl}`)).json();
      out[lbl] = { unread: j.messagesUnread ?? 0, total: j.messagesTotal ?? 0 };
    } catch {
      out[lbl] = { unread: 0, total: 0 };
    }
  }));
  return res.status(200).json(out);
}

function headerDate(dateHeader, internalDate) {
  if (dateHeader) {
    const t = new Date(dateHeader);
    if (!isNaN(t.getTime())) return t.toISOString();
  }
  if (internalDate) return new Date(Number(internalDate)).toISOString();
  return null;
}
