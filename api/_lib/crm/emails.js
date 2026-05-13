import sql from '../db.js';

// GET /api/crm/emails/:gmailMessageId — returns one full email message
// including body_html / body_text. Lazy-loaded by the deal detail UI when the
// user clicks an email row, so we don't bloat the deal payload with N×8KB
// HTML bodies. Authorization: caller must own the message OR the message's
// thread must be attached to at least one deal (workspace is single-tenant,
// so any deal access = visibility).
export async function emailsRoute(req, res, id, action, user) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!id) return res.status(400).json({ error: 'gmailMessageId required' });

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
