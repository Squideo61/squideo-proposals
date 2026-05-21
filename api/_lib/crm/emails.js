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
  if (!id) return listDealEmails(req, res, user);

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
// folder: every email linked to an ACTIVE (non-lost) deal, newest first.
// Generalises the per-deal email query in deals.js (which joins both
// email_thread_deals — thread scope — and email_message_deals — message scope)
// across all active deals. The workspace is single-tenant/shared, so (matching
// the deal-detail query) we don't filter by user_email. Each row carries the
// deal id(s)/title(s) it's linked to so the UI can show "Linked to <deal>".
const DEAL_FOLDER_PAGE = 50;

async function listDealEmails(req, res, user) { // eslint-disable-line no-unused-vars
  // The message-scope join table is created by a manual migration — self-heal
  // so workspaces that skipped it don't 500 on 'relation does not exist'.
  await ensureMessageDealsTable();

  const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
  const offset = Math.max(0, parseInt(qs.get('cursor') || '0', 10) || 0);

  const rows = await sql`
    SELECT em.gmail_message_id, em.gmail_thread_id, em.from_email,
           em.to_emails, em.cc_emails, em.subject, em.snippet,
           em.direction, em.sent_at,
           ARRAY_AGG(DISTINCT d.id)    AS deal_ids,
           ARRAY_AGG(DISTINCT d.title) AS deal_titles
    FROM email_messages em
    JOIN deals d
      ON d.stage <> 'lost'
     AND (
       EXISTS (SELECT 1 FROM email_thread_deals etd
                WHERE etd.gmail_thread_id = em.gmail_thread_id AND etd.deal_id = d.id)
       OR EXISTS (SELECT 1 FROM email_message_deals emd
                WHERE emd.gmail_message_id = em.gmail_message_id AND emd.deal_id = d.id)
     )
    WHERE em.internal_only = FALSE
    GROUP BY em.gmail_message_id, em.gmail_thread_id, em.from_email,
             em.to_emails, em.cc_emails, em.subject, em.snippet,
             em.direction, em.sent_at
    ORDER BY em.sent_at DESC
    LIMIT ${DEAL_FOLDER_PAGE + 1} OFFSET ${offset}
  `;

  const hasMore = rows.length > DEAL_FOLDER_PAGE;
  const page = hasMore ? rows.slice(0, DEAL_FOLDER_PAGE) : rows;

  return res.status(200).json({
    rows: page.map(em => ({
      gmailMessageId: em.gmail_message_id,
      gmailThreadId: em.gmail_thread_id,
      fromEmail: em.from_email || null,
      toEmails: em.to_emails || [],
      ccEmails: em.cc_emails || [],
      subject: em.subject || null,
      snippet: em.snippet || null,
      direction: em.direction,
      sentAt: em.sent_at,
      dealIds: (em.deal_ids || []).filter(Boolean),
      dealTitles: (em.deal_titles || []).filter(Boolean),
    })),
    nextCursor: hasMore ? offset + DEAL_FOLDER_PAGE : null,
  });
}
