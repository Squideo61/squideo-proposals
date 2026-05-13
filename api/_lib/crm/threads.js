import sql from '../db.js';
import { trimOrNull, lowerOrNull } from './shared.js';

// Endpoints the Chrome extension needs to talk to. Routes:
//   POST   /api/crm/threads                    — snapshot ingest from extension
//   GET    /api/crm/threads/by-contact?email=  — find deal(s) for a sender
//   GET    /api/crm/threads/by-thread-ids?ids= — bulk lookup for inbox chips
//   DELETE /api/crm/threads/:threadId?dealId=  — detach a thread from a deal
export async function threadsRoute(req, res, id, action, user) {
  if (!id) {
    if (req.method !== 'POST') return res.status(405).end();
    // Snapshot ingest. Body shape mirrors the extension's collected thread
    // metadata — we don't trust it blindly; we just persist what's given and
    // let the auto-link resolver's normal idempotency rules apply.
    const body = req.body || {};
    const gmailThreadId = trimOrNull(body.gmailThreadId);
    const gmailMessageId = trimOrNull(body.gmailMessageId);
    const dealId = trimOrNull(body.dealId);
    if (!gmailThreadId || !gmailMessageId) {
      return res.status(400).json({ error: 'gmailThreadId and gmailMessageId required' });
    }
    if (dealId) {
      const dealRow = (await sql`SELECT id FROM deals WHERE id = ${dealId}`)[0];
      if (!dealRow) return res.status(404).json({ error: 'Deal not found' });
    }

    const fromEmail = lowerOrNull(body.fromEmail);
    const toEmails = Array.isArray(body.toEmails) ? body.toEmails.map(s => String(s).toLowerCase()) : [];
    const ccEmails = Array.isArray(body.ccEmails) ? body.ccEmails.map(s => String(s).toLowerCase()) : [];
    const participants = Array.isArray(body.participantEmails) && body.participantEmails.length
      ? body.participantEmails.map(s => String(s).toLowerCase())
      : Array.from(new Set([fromEmail, ...toEmails, ...ccEmails].filter(Boolean)));
    const subject = trimOrNull(body.subject);
    const snippet = trimOrNull(body.snippet);
    const direction = body.direction === 'outbound' ? 'outbound' : 'inbound';
    const sentAt = body.sentAt ? new Date(body.sentAt).toISOString() : new Date().toISOString();

    // Upsert the thread row first so the FK on email_messages is satisfied.
    await sql`
      INSERT INTO email_threads (gmail_thread_id, user_email, subject, last_message_at, participant_emails)
      VALUES (${gmailThreadId}, ${user.email}, ${subject}, ${sentAt}, ${participants})
      ON CONFLICT (gmail_thread_id) DO UPDATE SET
        subject = COALESCE(email_threads.subject, EXCLUDED.subject),
        last_message_at = GREATEST(COALESCE(email_threads.last_message_at, '-infinity'::timestamptz), EXCLUDED.last_message_at),
        participant_emails = (
          SELECT COALESCE(array_agg(DISTINCT p), '{}')
          FROM unnest(COALESCE(email_threads.participant_emails, '{}') || EXCLUDED.participant_emails) AS p
        )
    `;

    // Idempotent on gmail_message_id — if Pub/Sub got here first, the
    // extension snapshot just no-ops which is exactly what we want.
    await sql`
      INSERT INTO email_messages (
        gmail_message_id, gmail_thread_id, user_email,
        from_email, to_emails, cc_emails, subject, snippet,
        direction, unmatched, internal_only, source, sent_at
      ) VALUES (
        ${gmailMessageId}, ${gmailThreadId}, ${user.email},
        ${fromEmail}, ${toEmails}, ${ccEmails}, ${subject}, ${snippet},
        ${direction}, ${!dealId}, FALSE, 'extension-snapshot', ${sentAt}
      )
      ON CONFLICT (gmail_message_id) DO NOTHING
    `;

    if (dealId) {
      await sql`
        INSERT INTO email_thread_deals (gmail_thread_id, deal_id, resolved_by)
        VALUES (${gmailThreadId}, ${dealId}, 'extension')
        ON CONFLICT (gmail_thread_id, deal_id) DO NOTHING
      `;
      // Clear unmatched on every message in the thread now that it's linked.
      await sql`UPDATE email_messages SET unmatched = FALSE WHERE gmail_thread_id = ${gmailThreadId}`;
      await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${dealId}`;
    }

    return res.status(200).json({ ok: true, gmailThreadId, dealId: dealId || null });
  }

  // Sub-routes accessed via /api/crm/threads/<id-or-action>
  if (id === 'by-contact') {
    if (req.method !== 'GET') return res.status(405).end();
    const email = String(req.query.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'email required' });
    // Match any non-lost deal where this email is the primary contact or
    // attached via deal_contacts. Ordered by recency so the sidebar can pick
    // the most relevant first if multiple match.
    const rows = await sql`
      SELECT DISTINCT d.id, d.title, d.stage, d.stage_changed_at, d.value,
                      d.last_activity_at, d.owner_email
      FROM deals d
      LEFT JOIN contacts pc ON pc.id = d.primary_contact_id
      LEFT JOIN deal_contacts dc ON dc.deal_id = d.id
      LEFT JOIN contacts c ON c.id = dc.contact_id
      WHERE d.stage <> 'lost'
        AND (LOWER(pc.email) = ${email} OR LOWER(c.email) = ${email})
      ORDER BY d.last_activity_at DESC NULLS LAST
      LIMIT 10
    `;
    return res.status(200).json(rows.map(r => ({
      id: r.id,
      title: r.title,
      stage: r.stage,
      stageChangedAt: r.stage_changed_at,
      value: r.value === null ? null : Number(r.value),
      lastActivityAt: r.last_activity_at,
      ownerEmail: r.owner_email || null,
    })));
  }

  if (id === 'by-thread-ids') {
    if (req.method !== 'GET') return res.status(405).end();
    const idsParam = String(req.query.ids || '').trim();
    if (!idsParam) return res.status(200).json({});
    const threadIds = idsParam.split(',').map(s => s.trim()).filter(Boolean);
    if (!threadIds.length) return res.status(200).json({});
    // Bulk resolver — the extension calls this once per inbox render to
    // decorate every visible thread row with its deal chip(s).
    const links = await sql`
      SELECT etd.gmail_thread_id, etd.deal_id, d.title, d.stage
      FROM email_thread_deals etd
      JOIN deals d ON d.id = etd.deal_id
      WHERE etd.gmail_thread_id = ANY(${threadIds})
    `;
    const byThread = {};
    for (const link of links) {
      if (!byThread[link.gmail_thread_id]) byThread[link.gmail_thread_id] = [];
      byThread[link.gmail_thread_id].push({
        dealId: link.deal_id,
        title: link.title,
        stage: link.stage,
      });
    }
    return res.status(200).json(byThread);
  }

  // Richer resolver used by the extension's chip renderer. Accepts a list
  // of { threadId, senderEmails } items in the POST body. For threads with
  // an explicit email_thread_deals row, returns that link (source:'explicit').
  // For threads without a link but whose sender emails match a contact on
  // an open deal, returns the matched deal(s) (source:'contact'). This is
  // what gives the inbox a chip on EVERY email from a known contact, like
  // Streak — without requiring every message to first pass through the
  // auto-link resolver at ingestion time.
  if (id === 'resolve') {
    if (req.method !== 'POST') return res.status(405).end();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(200).json({});

    const threadIds = items.map(i => i?.threadId).filter(Boolean);
    const byThread = {};
    const linkedThreads = new Set();

    if (threadIds.length) {
      const links = await sql`
        SELECT etd.gmail_thread_id, etd.deal_id, d.title, d.stage
        FROM email_thread_deals etd
        JOIN deals d ON d.id = etd.deal_id
        WHERE etd.gmail_thread_id = ANY(${threadIds})
      `;
      for (const link of links) {
        if (!byThread[link.gmail_thread_id]) byThread[link.gmail_thread_id] = [];
        byThread[link.gmail_thread_id].push({
          dealId: link.deal_id, title: link.title, stage: link.stage, source: 'explicit',
        });
        linkedThreads.add(link.gmail_thread_id);
      }
    }

    // Contact-based fallback for any thread that wasn't explicitly linked.
    const unlinked = items.filter(i =>
      i && i.threadId && !linkedThreads.has(i.threadId) &&
      Array.isArray(i.senderEmails) && i.senderEmails.length
    );
    if (unlinked.length) {
      const allEmails = Array.from(new Set(
        unlinked.flatMap(i => i.senderEmails.map(e => String(e).toLowerCase()))
      ));
      const matches = await sql`
        SELECT DISTINCT ON (LOWER(c.email), d.id)
               LOWER(c.email) AS email,
               d.id, d.title, d.stage, d.last_activity_at
        FROM deals d
        LEFT JOIN contacts pc ON pc.id = d.primary_contact_id
        LEFT JOIN deal_contacts dc ON dc.deal_id = d.id
        LEFT JOIN contacts c ON c.id = pc.id OR c.id = dc.contact_id
        WHERE d.stage <> 'lost'
          AND c.email IS NOT NULL
          AND LOWER(c.email) = ANY(${allEmails})
        ORDER BY LOWER(c.email), d.id, d.last_activity_at DESC NULLS LAST
      `;
      const dealsByEmail = {};
      for (const m of matches) {
        if (!dealsByEmail[m.email]) dealsByEmail[m.email] = [];
        dealsByEmail[m.email].push({
          dealId: m.id, title: m.title, stage: m.stage, source: 'contact',
        });
      }
      for (const item of unlinked) {
        const seen = new Map();
        for (const email of item.senderEmails) {
          for (const d of (dealsByEmail[String(email).toLowerCase()] || [])) {
            if (!seen.has(d.dealId)) seen.set(d.dealId, d);
          }
        }
        if (seen.size) byThread[item.threadId] = Array.from(seen.values()).slice(0, 3);
      }
    }

    return res.status(200).json(byThread);
  }

  // /api/crm/threads/:gmailThreadId  (DELETE with dealId in query)
  if (req.method === 'DELETE') {
    const dealId = trimOrNull(req.query.dealId);
    if (!dealId) return res.status(400).json({ error: 'dealId query param required' });
    await sql`
      DELETE FROM email_thread_deals
      WHERE gmail_thread_id = ${id} AND deal_id = ${dealId}
    `;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
