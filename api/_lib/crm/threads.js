import sql from '../db.js';
import { trimOrNull, lowerOrNull, ensureMessageDealsTable, ensureThreadDealBlocksTable } from './shared.js';

// Endpoints the Chrome extension + the SPA talk to. Routes:
//   POST   /api/crm/threads                            — snapshot ingest from extension
//   GET    /api/crm/threads/by-contact?email=          — find deal(s) for a sender
//   GET    /api/crm/threads/by-thread-ids?ids=         — bulk lookup for inbox chips
//   POST   /api/crm/threads/resolve                    — richer resolver for inbox chips
//   POST   /api/crm/threads/:threadId/link             — attach a thread or single message to another deal
//   DELETE /api/crm/threads/:threadId/link?dealId=…    — detach a thread or single message from a deal
//   DELETE /api/crm/threads/:threadId?dealId=          — legacy thread-only detach
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
      // A snapshot carrying a dealId is a deliberate user link from the
      // extension (attaching a suggestion / picking a deal), so clear any prior
      // "keep off this deal" block just like the /link POST does.
      await ensureThreadDealBlocksTable();
      await sql`DELETE FROM email_thread_deal_blocks WHERE gmail_thread_id = ${gmailThreadId} AND deal_id = ${dealId}`;
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
    // We must exclude the current user's own email from the match set —
    // otherwise any deal that has the user attached as a contact (e.g. a
    // test deal where the team is on the contact list) would chip every
    // thread the user has replied to. gmailSync's auto-linker applies the
    // same filter; this keeps the two resolvers consistent.
    const userEmail = (user.email || '').toLowerCase();
    const unlinked = items.filter(i =>
      i && i.threadId && !linkedThreads.has(i.threadId) &&
      Array.isArray(i.senderEmails) && i.senderEmails.length
    );
    if (unlinked.length) {
      const allEmails = Array.from(new Set(
        unlinked.flatMap(i => i.senderEmails
          .map(e => String(e).toLowerCase())
          .filter(e => e && e !== userEmail))
      ));
      if (!allEmails.length) return res.status(200).json(byThread);
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
      // Thread->deal pairs the user manually unlinked: never re-suggest them as
      // a contact-based chip, or the extension would offer to re-file (and the
      // auto-linker would rebuild) a link the user deliberately removed.
      await ensureThreadDealBlocksTable();
      const unlinkedThreadIds = unlinked.map(i => i.threadId);
      const blockRows = unlinkedThreadIds.length
        ? await sql`
            SELECT gmail_thread_id, deal_id FROM email_thread_deal_blocks
            WHERE gmail_thread_id = ANY(${unlinkedThreadIds})
          `
        : [];
      const blockedPairs = new Set(blockRows.map(r => `${r.gmail_thread_id}|${r.deal_id}`));

      for (const item of unlinked) {
        const seen = new Map();
        for (const email of item.senderEmails) {
          const lower = String(email).toLowerCase();
          if (!lower || lower === userEmail) continue;
          for (const d of (dealsByEmail[lower] || [])) {
            if (blockedPairs.has(`${item.threadId}|${d.dealId}`)) continue;
            if (!seen.has(d.dealId)) seen.set(d.dealId, d);
          }
        }
        if (seen.size) byThread[item.threadId] = Array.from(seen.values()).slice(0, 3);
      }
    }

    return res.status(200).json(byThread);
  }

  // /api/crm/threads/:gmailThreadId/link
  //   POST   body { dealId, scope: 'thread' | 'message', gmailMessageId? }
  //   DELETE query dealId, scope, gmailMessageId
  // Scope 'thread' uses the existing email_thread_deals join (resolved_by='manual');
  // scope 'message' uses the per-message email_message_deals join so a single
  // email can be filed against a different deal than the rest of its conversation.
  if (action === 'link') {
    await ensureMessageDealsTable();
    await ensureThreadDealBlocksTable();
    if (req.method === 'POST') {
      const body = req.body || {};
      const dealId = trimOrNull(body.dealId);
      const scope = body.scope === 'message' ? 'message' : 'thread';
      const gmailMessageId = trimOrNull(body.gmailMessageId);
      if (!dealId) return res.status(400).json({ error: 'dealId required' });
      if (scope === 'message' && !gmailMessageId) {
        return res.status(400).json({ error: 'gmailMessageId required when scope=message' });
      }
      const dealRow = (await sql`SELECT id, title FROM deals WHERE id = ${dealId}`)[0];
      if (!dealRow) return res.status(404).json({ error: 'Deal not found' });
      const threadRow = (await sql`SELECT gmail_thread_id FROM email_threads WHERE gmail_thread_id = ${id}`)[0];
      if (!threadRow) return res.status(404).json({ error: 'Thread not found' });

      if (scope === 'thread') {
        // Deliberately re-linking clears any prior "keep off this deal" block so
        // the auto-linker is free to maintain the link again.
        await sql`DELETE FROM email_thread_deal_blocks WHERE gmail_thread_id = ${id} AND deal_id = ${dealId}`;
        await sql`
          INSERT INTO email_thread_deals (gmail_thread_id, deal_id, resolved_by)
          VALUES (${id}, ${dealId}, 'manual')
          ON CONFLICT (gmail_thread_id, deal_id) DO NOTHING
        `;
        await sql`UPDATE email_messages SET unmatched = FALSE WHERE gmail_thread_id = ${id}`;
      } else {
        // Make sure the message exists and belongs to this thread before linking.
        const msgRow = (await sql`
          SELECT gmail_message_id FROM email_messages
          WHERE gmail_message_id = ${gmailMessageId} AND gmail_thread_id = ${id}
        `)[0];
        if (!msgRow) return res.status(404).json({ error: 'Message not found in this thread' });
        await sql`
          INSERT INTO email_message_deals (gmail_message_id, deal_id, linked_by_email)
          VALUES (${gmailMessageId}, ${dealId}, ${user.email || null})
          ON CONFLICT (gmail_message_id, deal_id) DO NOTHING
        `;
        await sql`UPDATE email_messages SET unmatched = FALSE WHERE gmail_message_id = ${gmailMessageId}`;
      }

      await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${dealId}`;
      await sql`
        INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
        VALUES (
          ${dealId},
          'email_linked',
          ${JSON.stringify({ gmailThreadId: id, gmailMessageId: gmailMessageId || null, scope, source: 'manual' })},
          ${user.email || null}
        )
      `;
      return res.status(200).json({
        ok: true,
        dealId,
        dealTitle: dealRow.title,
        scope,
        gmailMessageId: gmailMessageId || null,
      });
    }

    if (req.method === 'DELETE') {
      const dealId = trimOrNull(req.query.dealId);
      const scope = req.query.scope === 'message' ? 'message' : 'thread';
      const gmailMessageId = trimOrNull(req.query.gmailMessageId);
      if (!dealId) return res.status(400).json({ error: 'dealId required' });
      if (scope === 'message' && !gmailMessageId) {
        return res.status(400).json({ error: 'gmailMessageId required when scope=message' });
      }
      if (scope === 'thread') {
        await sql`
          DELETE FROM email_thread_deals
          WHERE gmail_thread_id = ${id} AND deal_id = ${dealId}
        `;
        // Also drop any per-message links for messages in this thread to the
        // same deal, so "unlink from this deal" fully detaches the conversation
        // rather than leaving orphaned message-scope links that keep it showing.
        await sql`
          DELETE FROM email_message_deals
          WHERE deal_id = ${dealId}
            AND gmail_message_id IN (
              SELECT gmail_message_id FROM email_messages WHERE gmail_thread_id = ${id}
            )
        `;
        // Remember the manual unlink so a later reply on this thread can't
        // rebuild the link via the contact/domain auto-link rules.
        await sql`
          INSERT INTO email_thread_deal_blocks (gmail_thread_id, deal_id, blocked_by)
          VALUES (${id}, ${dealId}, ${user.email || null})
          ON CONFLICT (gmail_thread_id, deal_id) DO NOTHING
        `;
      } else {
        await sql`
          DELETE FROM email_message_deals
          WHERE gmail_message_id = ${gmailMessageId} AND deal_id = ${dealId}
        `;
      }
      // Log the detach on the deal timeline (mirror of the 'email_linked' event).
      await sql`
        INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
        VALUES (
          ${dealId},
          'email_unlinked',
          ${JSON.stringify({ gmailThreadId: id, gmailMessageId: gmailMessageId || null, scope, source: 'manual' })},
          ${user.email || null}
        )
      `;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).end();
  }

  // /api/crm/threads/:gmailThreadId  (DELETE with dealId in query) — legacy
  // thread-only detach kept for the extension's existing call site.
  if (req.method === 'DELETE') {
    const dealId = trimOrNull(req.query.dealId);
    if (!dealId) return res.status(400).json({ error: 'dealId query param required' });
    await ensureThreadDealBlocksTable();
    await sql`
      DELETE FROM email_thread_deals
      WHERE gmail_thread_id = ${id} AND deal_id = ${dealId}
    `;
    // Record the manual unlink so the auto-linker won't rebuild it (mirrors the
    // /link DELETE handler above).
    await sql`
      INSERT INTO email_thread_deal_blocks (gmail_thread_id, deal_id, blocked_by)
      VALUES (${id}, ${dealId}, ${user.email || null})
      ON CONFLICT (gmail_thread_id, deal_id) DO NOTHING
    `;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
