import sql from '../db.js';

export async function triageRoute(req, res, id, action, user) {
  if (!id) {
    if (req.method !== 'GET') return res.status(405).end();
    // List the recent unmatched, non-internal messages for this user. Newest
    // first; cap at 100 so the UI can paginate later if needed.
    const rows = await sql`
      SELECT em.gmail_message_id, em.gmail_thread_id, em.from_email,
             em.to_emails, em.cc_emails, em.subject, em.snippet,
             em.direction, em.sent_at, em.user_email
      FROM email_messages em
      WHERE em.unmatched = TRUE
        AND em.internal_only = FALSE
        AND em.user_email = ${user.email}
        AND NOT EXISTS (
          SELECT 1 FROM email_thread_deals etd WHERE etd.gmail_thread_id = em.gmail_thread_id
        )
      ORDER BY em.sent_at DESC
      LIMIT 100
    `;
    return res.status(200).json(rows.map(em => ({
      gmailMessageId: em.gmail_message_id,
      gmailThreadId: em.gmail_thread_id,
      fromEmail: em.from_email || null,
      toEmails: em.to_emails || [],
      ccEmails: em.cc_emails || [],
      subject: em.subject || null,
      snippet: em.snippet || null,
      direction: em.direction,
      sentAt: em.sent_at,
      userEmail: em.user_email,
    })));
  }

  // /api/crm/triage/<gmail_thread_id>/assign
  if (action === 'assign') {
    if (req.method !== 'POST') return res.status(405).end();
    const { dealId } = req.body || {};
    if (!dealId) return res.status(400).json({ error: 'dealId required' });

    const deal = (await sql`SELECT id FROM deals WHERE id = ${dealId}`)[0];
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    // Idempotent attach. id here is the gmail_thread_id (URL: /triage/<thread>/assign).
    await sql`
      INSERT INTO email_thread_deals (gmail_thread_id, deal_id, resolved_by)
      VALUES (${id}, ${dealId}, 'manual')
      ON CONFLICT (gmail_thread_id, deal_id) DO NOTHING
    `;
    // Clear unmatched flag on every message in this thread.
    await sql`
      UPDATE email_messages SET unmatched = FALSE
      WHERE gmail_thread_id = ${id}
    `;
    await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${dealId}`;
    return res.status(200).json({ ok: true });
  }

  if (action === 'dismiss') {
    if (req.method !== 'POST') return res.status(405).end();
    // Mark every message in the thread as no-longer-unmatched without
    // attaching to any deal. Useful for spam/personal mail that landed in
    // the triage queue.
    await sql`UPDATE email_messages SET unmatched = FALSE WHERE gmail_thread_id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(404).json({ error: 'Unknown triage action' });
}
