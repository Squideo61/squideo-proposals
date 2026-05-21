import sql from '../db.js';
import { ensureMessageDealsTable } from './shared.js';

// GET /api/crm/emails/:gmailMessageId — returns one full email message
// including body_html / body_text. Lazy-loaded by the deal detail UI when the
// user clicks an email row, so we don't bloat the deal payload with N×8KB
// HTML bodies. Authorization: caller must own the message OR the message's
// thread must be attached to at least one deal (workspace is single-tenant,
// so any deal access = visibility).
export async function emailsRoute(req, res, id, action, user) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!id) {
    const threadId = new URLSearchParams((req.url || '').split('?')[1] || '').get('threadId');
    return threadId ? getDealThread(req, res, threadId) : listDealEmails(req, res, user);
  }

  const rows = await sql`
    SELECT em.gmail_message_id, em.gmail_thread_id, em.user_email,
           em.from_email, em.to_emails, em.cc_emails,
           em.subject, em.snippet, em.body_html, em.body_text,
           em.direction, em.sent_at, em.gmail_attachments
    FROM email_messages em
    WHERE em.gmail_message_id = ${id}
  `;
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const em = rows[0];

  if (em.user_email !== user.email) {
    const linked = await sql`
      SELECT 1 FROM email_thread_deals WHERE gmail_thread_id = ${em.gmail_thread_id} LIMIT 1
    `;
    if (!linked.length) return res.status(403).json({ error: 'Forbidden' });
  }

  return res.status(200).json({
    gmailMessageId: em.gmail_message_id,
    gmailThreadId: em.gmail_thread_id,
    userEmail: em.user_email,
    fromEmail: em.from_email || null,
    toEmails: em.to_emails || [],
    ccEmails: em.cc_emails || [],
    subject: em.subject || null,
    snippet: em.snippet || null,
    bodyHtml: em.body_html || null,
    bodyText: em.body_text || null,
    direction: em.direction,
    sentAt: em.sent_at,
    attachments: em.gmail_attachments || [],
  });
}

// GET /api/crm/emails?cursor=<offset> — the Emails section's default "Deals"
// folder, grouped into conversations like Gmail: one row per THREAD that has
// at least one message linked to an ACTIVE (non-lost) deal, newest activity
// first. A thread qualifies via either the thread-scope link
// (email_thread_deals) or any message-scope link (email_message_deals). The
// workspace is single-tenant/shared, so (matching the deal-detail query) we
// don't filter by user_email. Each row carries the latest message preview, the
// conversation length, and the deal id(s)/title(s) it's linked to.
const DEAL_FOLDER_PAGE = 50;

async function listDealEmails(req, res, user) { // eslint-disable-line no-unused-vars
  // The message-scope join table is created by a manual migration — self-heal
  // so workspaces that skipped it don't 500 on 'relation does not exist'.
  await ensureMessageDealsTable();

  const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
  const offset = Math.max(0, parseInt(qs.get('cursor') || '0', 10) || 0);

  const rows = await sql`
    WITH qualifying AS (
      SELECT DISTINCT em.gmail_thread_id AS tid
      FROM email_messages em
      WHERE em.internal_only = FALSE
        AND em.gmail_message_id NOT LIKE '%-stub'
        AND EXISTS (
          SELECT 1 FROM deals d
          WHERE d.stage <> 'lost' AND (
            EXISTS (SELECT 1 FROM email_thread_deals etd
                     WHERE etd.gmail_thread_id = em.gmail_thread_id AND etd.deal_id = d.id)
            OR EXISTS (SELECT 1 FROM email_message_deals emd
                     WHERE emd.gmail_message_id = em.gmail_message_id AND emd.deal_id = d.id)
          )
        )
    ),
    threads AS (
      SELECT q.tid,
             COUNT(em.gmail_message_id) AS message_count,
             MAX(em.sent_at)            AS last_at
      FROM qualifying q
      JOIN email_messages em ON em.gmail_thread_id = q.tid AND em.internal_only = FALSE
                            AND em.gmail_message_id NOT LIKE '%-stub'
      GROUP BY q.tid
    )
    SELECT th.tid AS gmail_thread_id, th.message_count, th.last_at,
           COALESCE(et.subject, lm.subject) AS subject,
           lm.from_email AS last_from, lm.snippet AS last_snippet, lm.direction AS last_direction,
           da.deal_ids, da.deal_titles, da.deal_stages
    FROM threads th
    LEFT JOIN email_threads et ON et.gmail_thread_id = th.tid
    JOIN LATERAL (
      SELECT from_email, snippet, direction, subject
      FROM email_messages
      WHERE gmail_thread_id = th.tid AND internal_only = FALSE
        AND gmail_message_id NOT LIKE '%-stub'
      ORDER BY sent_at DESC
      LIMIT 1
    ) lm ON TRUE
    LEFT JOIN LATERAL (
      SELECT ARRAY_AGG(d.id ORDER BY d.id) AS deal_ids,
             ARRAY_AGG(d.title ORDER BY d.id) AS deal_titles,
             ARRAY_AGG(d.stage ORDER BY d.id) AS deal_stages
      FROM deals d
      WHERE d.stage <> 'lost' AND (
        EXISTS (SELECT 1 FROM email_thread_deals etd
                 WHERE etd.gmail_thread_id = th.tid AND etd.deal_id = d.id)
        OR EXISTS (SELECT 1 FROM email_message_deals emd
                     JOIN email_messages e2 ON e2.gmail_message_id = emd.gmail_message_id
                    WHERE e2.gmail_thread_id = th.tid AND emd.deal_id = d.id)
      )
    ) da ON TRUE
    ORDER BY th.last_at DESC
    LIMIT ${DEAL_FOLDER_PAGE + 1} OFFSET ${offset}
  `;

  const hasMore = rows.length > DEAL_FOLDER_PAGE;
  const page = hasMore ? rows.slice(0, DEAL_FOLDER_PAGE) : rows;

  return res.status(200).json({
    rows: page.map(t => ({
      gmailThreadId: t.gmail_thread_id,
      subject: t.subject || null,
      lastFrom: t.last_from || null,
      lastSnippet: t.last_snippet || null,
      lastDirection: t.last_direction,
      sentAt: t.last_at,
      messageCount: Number(t.message_count) || 1,
      dealIds: (t.deal_ids || []).filter(Boolean),
      dealTitles: (t.deal_titles || []).filter(Boolean),
      dealStages: (t.deal_stages || []).filter(Boolean),
    })),
    nextCursor: hasMore ? offset + DEAL_FOLDER_PAGE : null,
  });
}

// GET /api/crm/emails?threadId=<id> — every stored message in one conversation
// (oldest first), with bodies, for the Deals/Triage reading view. Shapes each
// message like the live Gmail thread messages so the UI renders them uniformly.
async function getDealThread(req, res, threadId) {
  const rows = await sql`
    SELECT gmail_message_id, gmail_thread_id, from_email, to_emails, cc_emails,
           subject, snippet, body_html, body_text, direction, sent_at, gmail_attachments
    FROM email_messages
    WHERE gmail_thread_id = ${threadId} AND internal_only = FALSE
      AND gmail_message_id NOT LIKE '%-stub'
    ORDER BY sent_at ASC
  `;
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  return res.status(200).json({
    id: threadId,
    threadId,
    subject: rows[rows.length - 1].subject || rows[0].subject || null,
    messages: rows.map(em => ({
      id: em.gmail_message_id,
      from: em.from_email || null,
      fromEmail: em.from_email || null,
      to: em.to_emails || [],
      cc: em.cc_emails || [],
      subject: em.subject || null,
      date: em.sent_at,
      snippet: em.snippet || null,
      html: em.body_html || null,
      text: em.body_text || null,
      attachments: em.gmail_attachments || [],
      outbound: em.direction === 'outbound' || em.direction === 'outgoing',
    })),
  });
}
