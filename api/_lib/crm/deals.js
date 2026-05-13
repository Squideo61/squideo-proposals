import crypto from 'node:crypto';
import { put, del, getDownloadUrl } from '@vercel/blob';
import sql from '../db.js';
import { isValidStage } from '../dealStage.js';
import { makeId, trimOrNull, numberOrNull } from './shared.js';
import { serialiseTask } from './tasks.js';
import { serialiseComment } from './comments.js';
import { getFreshAccessToken } from './gmail.js';

export async function dealsRoute(req, res, id, action, user, subaction = null) {
  if (!id) {
    if (req.method === 'GET') {
      // Optional filter by stage, owner. Default: everything (Kanban renders
      // stages as columns and groups client-side).
      const stage = req.query.stage ? String(req.query.stage) : null;
      const owner = req.query.owner ? String(req.query.owner) : null;
      let rows;
      if (stage && owner) {
        rows = await sql`
          SELECT id, title, company_id, primary_contact_id, owner_email, stage, stage_changed_at,
                 value, expected_close_at, lost_reason, notes, last_activity_at, created_at, updated_at
          FROM deals WHERE stage = ${stage} AND owner_email = ${owner}
          ORDER BY stage_changed_at DESC
        `;
      } else if (stage) {
        rows = await sql`
          SELECT id, title, company_id, primary_contact_id, owner_email, stage, stage_changed_at,
                 value, expected_close_at, lost_reason, notes, last_activity_at, created_at, updated_at
          FROM deals WHERE stage = ${stage}
          ORDER BY stage_changed_at DESC
        `;
      } else if (owner) {
        rows = await sql`
          SELECT id, title, company_id, primary_contact_id, owner_email, stage, stage_changed_at,
                 value, expected_close_at, lost_reason, notes, last_activity_at, created_at, updated_at
          FROM deals WHERE owner_email = ${owner}
          ORDER BY stage_changed_at DESC
        `;
      } else {
        rows = await sql`
          SELECT id, title, company_id, primary_contact_id, owner_email, stage, stage_changed_at,
                 value, expected_close_at, lost_reason, notes, last_activity_at, created_at, updated_at
          FROM deals ORDER BY stage_changed_at DESC
        `;
      }

      // Annotate with primary contact + linked-proposal counts so the Kanban
      // can render without n+1 fetches.
      const ids = rows.map(r => r.id);
      const proposalCounts = ids.length
        ? await sql`SELECT deal_id, COUNT(*)::int AS n FROM proposals WHERE deal_id = ANY(${ids}) GROUP BY deal_id`
        : [];
      const propMap = new Map(proposalCounts.map(r => [r.deal_id, r.n]));

      return res.status(200).json(rows.map(r => ({
        ...serialiseDeal(r),
        proposalCount: propMap.get(r.id) || 0,
      })));
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const title = trimOrNull(body.title);
      if (!title) return res.status(400).json({ error: 'title is required' });
      const newId = body.id || makeId('deal');
      const stage = isValidStage(body.stage) ? body.stage : 'lead';
      await sql`
        INSERT INTO deals (id, title, company_id, primary_contact_id, owner_email, stage, value, expected_close_at, notes)
        VALUES (
          ${newId},
          ${title},
          ${trimOrNull(body.companyId) || null},
          ${trimOrNull(body.primaryContactId) || null},
          ${trimOrNull(body.ownerEmail) || user.email},
          ${stage},
          ${numberOrNull(body.value)},
          ${trimOrNull(body.expectedCloseAt)},
          ${trimOrNull(body.notes)}
        )
      `;
      await sql`
        INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
        VALUES (${newId}, 'deal_created', ${JSON.stringify({ title, stage, source: 'manual' })}, ${user.email || null})
      `;
      const rows = await sql`
        SELECT id, title, company_id, primary_contact_id, owner_email, stage, stage_changed_at,
               value, expected_close_at, lost_reason, notes, last_activity_at, created_at, updated_at
        FROM deals WHERE id = ${newId}
      `;
      return res.status(201).json(serialiseDeal(rows[0]));
    }
    return res.status(405).end();
  }

  // Sub-routes: /deals/:id/stage and /deals/:id/events
  if (action === 'stage') {
    if (req.method !== 'POST') return res.status(405).end();
    const { stage, lostReason } = req.body || {};
    if (!isValidStage(stage)) return res.status(400).json({ error: 'Invalid stage' });
    // Manual move: bypass the forward-only ratchet but still record an event.
    const cur = (await sql`SELECT stage FROM deals WHERE id = ${id}`)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    if (cur.stage === stage && stage !== 'lost') {
      return res.status(200).json({ ok: true, changed: false });
    }
    await sql`
      UPDATE deals
         SET stage = ${stage},
             stage_changed_at = NOW(),
             last_activity_at = NOW(),
             lost_reason = ${stage === 'lost' ? trimOrNull(lostReason) : null},
             updated_at = NOW()
       WHERE id = ${id}
    `;
    await sql`
      INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
      VALUES (${id}, 'stage_change', ${JSON.stringify({ from: cur.stage, to: stage, manual: true, lostReason: lostReason || null })}, ${user.email || null})
    `;
    const rows = await sql`
      SELECT id, title, company_id, primary_contact_id, owner_email, stage, stage_changed_at,
             value, expected_close_at, lost_reason, notes, last_activity_at, created_at, updated_at
      FROM deals WHERE id = ${id}
    `;
    return res.status(200).json({ ok: true, changed: true, deal: serialiseDeal(rows[0]) });
  }

  if (action === 'comments') {
    if (req.method !== 'POST') return res.status(405).end();
    const body = req.body || {};
    const text = trimOrNull(body.body);
    if (!text) return res.status(400).json({ error: 'body is required' });
    const parentId = trimOrNull(body.parentId) || null;
    const mentions = Array.isArray(body.mentions) ? body.mentions.filter(m => typeof m === 'string') : [];
    const newId = makeId('cmt');
    await sql`
      INSERT INTO deal_comments (id, deal_id, parent_id, body, mentions, created_by)
      VALUES (${newId}, ${id}, ${parentId}, ${text}, ${mentions}, ${user.email})
    `;
    await sql`
      UPDATE deals SET last_activity_at = NOW(), updated_at = NOW() WHERE id = ${id}
    `;
    const rows = await sql`
      SELECT c.id, c.deal_id, c.parent_id, c.body, c.mentions,
             c.created_by, c.created_at, c.updated_at,
             u.name AS author_name, u.avatar AS author_avatar
      FROM deal_comments c
      JOIN users u ON u.email = c.created_by
      WHERE c.id = ${newId}
    `;
    return res.status(201).json(serialiseComment(rows[0]));
  }

  if (action === 'events') {
    if (req.method !== 'GET') return res.status(405).end();
    const rows = await sql`
      SELECT id, deal_id, event_type, payload, actor_email, occurred_at
      FROM deal_events
      WHERE deal_id = ${id}
      ORDER BY occurred_at DESC
      LIMIT 200
    `;
    return res.status(200).json(rows.map(r => ({
      id: Number(r.id),
      dealId: r.deal_id,
      eventType: r.event_type,
      payload: r.payload || {},
      actorEmail: r.actor_email || null,
      occurredAt: r.occurred_at,
    })));
  }

  // Used by the in-Gmail Boxes RouteView — every thread attached to this deal.
  if (action === 'threads') {
    if (req.method !== 'GET') return res.status(405).end();
    const rows = await sql`
      SELECT et.gmail_thread_id, et.subject, et.last_message_at, et.participant_emails,
             (SELECT COUNT(*) FROM email_messages em WHERE em.gmail_thread_id = et.gmail_thread_id)::int AS message_count
      FROM email_threads et
      JOIN email_thread_deals etd ON etd.gmail_thread_id = et.gmail_thread_id
      WHERE etd.deal_id = ${id}
      ORDER BY et.last_message_at DESC NULLS LAST
      LIMIT 200
    `;
    return res.status(200).json(rows.map(r => ({
      gmailThreadId: r.gmail_thread_id,
      subject: r.subject || null,
      lastMessageAt: r.last_message_at,
      participantEmails: r.participant_emails || [],
      messageCount: r.message_count || 0,
    })));
  }

  // /deals/:id/files — upload a new file (POST) or list (unused, GET falls through)
  if (action === 'files' && !subaction && req.method === 'POST') {
    if (!process.env.BLOB_READ_WRITE_TOKEN)
      return res.status(503).json({ error: 'File storage not configured' });

    const filename = decodeURIComponent(req.headers['x-filename'] || 'upload');
    const mimeType = req.headers['content-type'] || 'application/octet-stream';

    let fileBuffer = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : null;
    if (!fileBuffer) {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      fileBuffer = Buffer.concat(chunks);
    }
    if (!fileBuffer || fileBuffer.length === 0)
      return res.status(400).json({ error: 'No file data received' });
    if (fileBuffer.length > 20 * 1024 * 1024)
      return res.status(413).json({ error: 'File too large (max 20 MB)' });

    const fileId = crypto.randomUUID();
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = await put(`deal-files/${id}/${fileId}/${safeName}`, fileBuffer, {
      access: 'private', contentType: mimeType,
    });

    await sql`
      INSERT INTO deal_files (id, deal_id, filename, mime_type, size_bytes, blob_url, blob_pathname, uploaded_by, source)
      VALUES (${fileId}, ${id}, ${filename}, ${mimeType}, ${fileBuffer.length},
              ${blob.url}, ${blob.pathname}, ${user.email}, 'upload')
    `;
    return res.status(201).json({
      id: fileId, filename, mimeType, sizeBytes: fileBuffer.length,
      uploadedBy: user.email, source: 'upload',
      createdAt: new Date().toISOString(),
    });
  }

  // /deals/:id/files/:fileId — generate a signed download URL (GET) or delete (DELETE)
  if (action === 'files' && subaction && subaction !== 'from-email' && req.method === 'GET') {
    const rows = await sql`
      SELECT blob_url, filename FROM deal_files WHERE id = ${subaction} AND deal_id = ${id}
    `;
    if (!rows.length) return res.status(404).json({ error: 'File not found' });
    const downloadUrl = await getDownloadUrl(rows[0].blob_url);
    return res.status(200).json({ downloadUrl, filename: rows[0].filename });
  }

  if (action === 'files' && subaction && subaction !== 'from-email' && req.method === 'DELETE') {
    const rows = await sql`
      SELECT blob_url, uploaded_by FROM deal_files WHERE id = ${subaction} AND deal_id = ${id}
    `;
    if (!rows.length) return res.status(404).json({ error: 'File not found' });
    if (user.role !== 'admin' && rows[0].uploaded_by !== user.email) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    try { await del(rows[0].blob_url); } catch (err) {
      console.error('[deal files] blob delete failed', err.message);
    }
    await sql`DELETE FROM deal_files WHERE id = ${subaction} AND deal_id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  // /deals/:id/files/from-email — copy an email attachment into deal files
  if (action === 'files' && subaction === 'from-email' && req.method === 'POST') {
    if (!process.env.BLOB_READ_WRITE_TOKEN)
      return res.status(503).json({ error: 'File storage not configured' });

    const { gmailMessageId, attachmentId, filename, mimeType, size } = req.body || {};
    if (!gmailMessageId || !attachmentId || !filename)
      return res.status(400).json({ error: 'gmailMessageId, attachmentId, filename required' });

    const msgRows = await sql`
      SELECT em.user_email FROM email_messages em
      JOIN email_thread_deals etd ON etd.gmail_thread_id = em.gmail_thread_id
      WHERE em.gmail_message_id = ${gmailMessageId} AND etd.deal_id = ${id}
      LIMIT 1
    `;
    if (!msgRows.length) return res.status(403).json({ error: 'Email not linked to this deal' });

    const accessToken = await getFreshAccessToken(msgRows[0].user_email);

    const attRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(gmailMessageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    if (!attRes.ok) return res.status(502).json({ error: `Gmail fetch failed (${attRes.status})` });
    const { data } = await attRes.json();
    const attBuffer = Buffer.from(data, 'base64url');

    if (attBuffer.length > 20 * 1024 * 1024)
      return res.status(413).json({ error: 'Attachment too large (max 20 MB)' });

    const fileId = crypto.randomUUID();
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = await put(`deal-files/${id}/${fileId}/${safeName}`, attBuffer, {
      access: 'private', contentType: mimeType || 'application/octet-stream',
    });

    await sql`
      INSERT INTO deal_files (id, deal_id, filename, mime_type, size_bytes, blob_url, blob_pathname, uploaded_by, source)
      VALUES (${fileId}, ${id}, ${filename}, ${mimeType || null}, ${attBuffer.length},
              ${blob.url}, ${blob.pathname}, ${user.email}, 'email')
    `;
    return res.status(201).json({
      id: fileId, filename, mimeType: mimeType || null, sizeBytes: attBuffer.length,
      uploadedBy: user.email, source: 'email',
      createdAt: new Date().toISOString(),
    });
  }

  // /deals/:id (no action)
  if (req.method === 'GET') {
    const rows = await sql`
      SELECT id, title, company_id, primary_contact_id, owner_email, stage, stage_changed_at,
             value, expected_close_at, lost_reason, notes, last_activity_at, created_at, updated_at
      FROM deals WHERE id = ${id}
    `;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const deal = serialiseDeal(rows[0]);
    const [proposals, events, tasks, emails, files, comments] = await Promise.all([
      sql`SELECT id, data, number_year, number_seq, created_at FROM proposals WHERE deal_id = ${id} ORDER BY created_at DESC`,
      sql`SELECT id, deal_id, event_type, payload, actor_email, occurred_at FROM deal_events WHERE deal_id = ${id} ORDER BY occurred_at DESC LIMIT 100`,
      sql`
        SELECT t.*,
          (SELECT COALESCE(ARRAY_AGG(ta.user_email ORDER BY ta.assigned_at), '{}')
           FROM task_assignees ta WHERE ta.task_id = t.id) AS assignee_emails
        FROM tasks t
        WHERE t.deal_id = ${id}
        ORDER BY done_at NULLS FIRST, due_at ASC NULLS LAST
        LIMIT 50
      `,
      // Every email_message attached to this deal via the M:N join. Cap at
      // 200 so we don't truncate long threads — Gmail's API itself caps
      // typical conversations at well under that.
      sql`
        SELECT em.gmail_message_id, em.gmail_thread_id, em.from_email,
               em.to_emails, em.cc_emails, em.subject, em.snippet,
               em.direction, em.sent_at, em.user_email
        FROM email_messages em
        JOIN email_thread_deals etd ON etd.gmail_thread_id = em.gmail_thread_id
        WHERE etd.deal_id = ${id} AND em.internal_only = FALSE
        ORDER BY em.sent_at DESC
        LIMIT 200
      `,
      sql`SELECT id, filename, mime_type, size_bytes, blob_url,
               uploaded_by, source, created_at
          FROM deal_files WHERE deal_id = ${id} ORDER BY created_at DESC LIMIT 100`,
      sql`
        SELECT c.id, c.deal_id, c.parent_id, c.body, c.mentions,
               c.created_by, c.created_at, c.updated_at,
               u.name AS author_name, u.avatar AS author_avatar
        FROM deal_comments c
        JOIN users u ON u.email = c.created_by
        WHERE c.deal_id = ${id}
        ORDER BY c.created_at ASC
      `,
    ]);

    // Load reactions for all comments in one query and merge into comments.
    // Wrapped in try/catch so a missing table (pre-migration) doesn't break the endpoint.
    const commentIds = comments.map(c => c.id);
    const reactionsMap = {};
    try {
      const reactionRows = commentIds.length ? await sql`
        SELECT comment_id, emoji, ARRAY_AGG(user_email) AS users, COUNT(*) AS cnt
        FROM deal_comment_reactions
        WHERE comment_id = ANY(${commentIds})
        GROUP BY comment_id, emoji
      ` : [];
      for (const r of reactionRows) {
        if (!reactionsMap[r.comment_id]) reactionsMap[r.comment_id] = {};
        reactionsMap[r.comment_id][r.emoji] = { count: Number(r.cnt), users: r.users };
      }
    } catch (_) { /* table not yet migrated — reactions load as empty */ }

    return res.status(200).json({
      ...deal,
      proposals: proposals.map(p => ({
        id: p.id,
        clientName: p.data?.clientName || null,
        contactBusinessName: p.data?.contactBusinessName || null,
        basePrice: p.data?.basePrice || null,
        number: p.number_year && p.number_seq ? { year: p.number_year, seq: p.number_seq } : null,
        createdAt: p.created_at,
      })),
      events: events.map(e => ({
        id: Number(e.id),
        eventType: e.event_type,
        payload: e.payload || {},
        actorEmail: e.actor_email || null,
        occurredAt: e.occurred_at,
      })),
      tasks: tasks.map(serialiseTask),
      emails: emails.map(em => ({
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
      })),
      files: files.map(f => ({
        id: f.id, filename: f.filename, mimeType: f.mime_type || null,
        sizeBytes: f.size_bytes || null, blobUrl: f.blob_url,
        uploadedBy: f.uploaded_by || null, source: f.source,
        createdAt: f.created_at,
      })),
      comments: comments.map(c => serialiseComment(c, reactionsMap[c.id] || {})),
    });
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const cur = (await sql`
      SELECT id, title, company_id, primary_contact_id, owner_email, stage, stage_changed_at,
             value, expected_close_at, lost_reason, notes, last_activity_at, created_at, updated_at
      FROM deals WHERE id = ${id}
    `)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const next = {
      title:               'title'             in body ? (trimOrNull(body.title) || cur.title) : cur.title,
      company_id:          'companyId'         in body ? (trimOrNull(body.companyId) || null) : cur.company_id,
      primary_contact_id:  'primaryContactId'  in body ? (trimOrNull(body.primaryContactId) || null) : cur.primary_contact_id,
      owner_email:         'ownerEmail'        in body ? (trimOrNull(body.ownerEmail) || null) : cur.owner_email,
      value:               'value'             in body ? numberOrNull(body.value) : cur.value,
      expected_close_at:   'expectedCloseAt'   in body ? (trimOrNull(body.expectedCloseAt)) : cur.expected_close_at,
      notes:               'notes'             in body ? trimOrNull(body.notes) : cur.notes,
    };
    await sql`
      UPDATE deals SET
        title = ${next.title},
        company_id = ${next.company_id},
        primary_contact_id = ${next.primary_contact_id},
        owner_email = ${next.owner_email},
        value = ${next.value},
        expected_close_at = ${next.expected_close_at},
        notes = ${next.notes},
        last_activity_at = NOW(),
        updated_at = NOW()
      WHERE id = ${id}
    `;
    const rows = await sql`
      SELECT id, title, company_id, primary_contact_id, owner_email, stage, stage_changed_at,
             value, expected_close_at, lost_reason, notes, last_activity_at, created_at, updated_at
      FROM deals WHERE id = ${id}
    `;
    return res.status(200).json(serialiseDeal(rows[0]));
  }

  if (req.method === 'DELETE') {
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    await sql`DELETE FROM deals WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}

export function serialiseDeal(r) {
  return {
    id: r.id,
    title: r.title,
    companyId: r.company_id || null,
    primaryContactId: r.primary_contact_id || null,
    ownerEmail: r.owner_email || null,
    stage: r.stage,
    stageChangedAt: r.stage_changed_at,
    value: r.value === null || r.value === undefined ? null : Number(r.value),
    expectedCloseAt: r.expected_close_at || null,
    lostReason: r.lost_reason || null,
    notes: r.notes || null,
    lastActivityAt: r.last_activity_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
