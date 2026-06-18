import sql from '../db.js';
import { trimOrNull } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { sendNotification, ensureCommentMentionNotificationDefault } from '../notifications.js';
import { APP_URL } from '../email.js';

const ALLOWED_REACTIONS = ['👍', '👎', '❤️', '😂', '🎉', '👀'];

// Notify @-mentioned teammates about a comment. `mentions` are user emails;
// the author is always excluded. Best-effort — callers wrap in try/catch so a
// notification hiccup never fails the comment write. Lands in the Updates bell
// (+ email + desktop push) and deep-links to the deal, where comments live for
// both deal and project/video pages.
export async function notifyCommentMentions({ dealId, body, mentions, author }) {
  const authorEmail = String(author?.email || '').toLowerCase();
  const recipients = Array.from(new Set(
    (mentions || []).map(e => String(e).toLowerCase()).filter(Boolean)
  )).filter(e => e !== authorEmail);
  if (!recipients.length) return;
  await ensureCommentMentionNotificationDefault();
  const deal = (await sql`SELECT title FROM deals WHERE id = ${dealId}`)[0];
  const dealTitle = deal?.title || 'a deal';
  const authorName = author?.name || author?.email || 'A teammate';
  const snippet = body.length > 280 ? body.slice(0, 277) + '…' : body;
  const link = `#/deal/${dealId}`;
  await sendNotification('comment.mention', {
    assigneeEmails: recipients,
    excludeEmails: authorEmail ? [authorEmail] : null,
    subject: `${authorName} mentioned you — ${dealTitle}`,
    text: `${authorName} mentioned you in a comment on ${dealTitle}:\n\n"${snippet}"\n\n${APP_URL}/${link}`,
    inApp: { title: `${authorName} mentioned you`, body: snippet, link },
  });
}

export async function commentsRoute(req, res, id, action, user) {
  if (!id) return res.status(404).json({ error: 'Comment id required' });

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const text = trimOrNull(body.body);
    if (!text) return res.status(400).json({ error: 'body is required' });
    const mentions = Array.isArray(body.mentions) ? body.mentions.filter(m => typeof m === 'string') : [];
    const rows = await sql`SELECT created_by, deal_id, mentions FROM deal_comments WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].created_by !== user.email && !hasPermission(await getRole(user.role), 'comments.manage_all'))
      return res.status(403).json({ error: 'Forbidden' });
    await sql`
      UPDATE deal_comments SET body = ${text}, mentions = ${mentions}, updated_at = NOW()
      WHERE id = ${id}
    `;
    // Notify only people newly @-mentioned by this edit (not those already
    // pinged when the comment was first posted). Best-effort.
    const already = new Set((rows[0].mentions || []).map(e => String(e).toLowerCase()));
    const added = mentions.filter(e => !already.has(String(e).toLowerCase()));
    if (added.length) {
      try { await notifyCommentMentions({ dealId: rows[0].deal_id, body: text, mentions: added, author: user }); }
      catch (err) { console.error('[comments] mention notify (edit) failed', err); }
    }
    const updated = await sql`
      SELECT c.id, c.deal_id, c.parent_id, c.body, c.mentions,
             c.created_by, c.created_at, c.updated_at,
             u.name AS author_name, u.avatar AS author_avatar
      FROM deal_comments c
      JOIN users u ON u.email = c.created_by
      WHERE c.id = ${id}
    `;
    return res.status(200).json(serialiseComment(updated[0]));
  }

  if (req.method === 'DELETE') {
    const rows = await sql`SELECT created_by FROM deal_comments WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].created_by !== user.email && !hasPermission(await getRole(user.role), 'comments.manage_all'))
      return res.status(403).json({ error: 'Forbidden' });
    await sql`DELETE FROM deal_comments WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  // ── React (POST /:id/react) ─────────────────────────────────────────────
  if (req.method === 'POST' && action === 'react') {
    const emoji = (req.body || {}).emoji;
    if (!ALLOWED_REACTIONS.includes(emoji))
      return res.status(400).json({ error: 'Invalid emoji' });

    const rows = await sql`SELECT id FROM deal_comments WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    // Toggle: remove if the user already reacted with this emoji, add if not.
    const existing = await sql`
      SELECT 1 FROM deal_comment_reactions
      WHERE comment_id = ${id} AND user_email = ${user.email} AND emoji = ${emoji}
    `;
    if (existing.length) {
      await sql`
        DELETE FROM deal_comment_reactions
        WHERE comment_id = ${id} AND user_email = ${user.email} AND emoji = ${emoji}
      `;
    } else {
      await sql`
        INSERT INTO deal_comment_reactions (comment_id, user_email, emoji)
        VALUES (${id}, ${user.email}, ${emoji})
        ON CONFLICT DO NOTHING
      `;
    }

    const reactionRows = await sql`
      SELECT emoji, ARRAY_AGG(user_email) AS users, COUNT(*) AS cnt
      FROM deal_comment_reactions
      WHERE comment_id = ${id}
      GROUP BY emoji
    `;
    const reactions = {};
    for (const r of reactionRows) {
      reactions[r.emoji] = { count: Number(r.cnt), users: r.users };
    }
    return res.status(200).json({ reactions });
  }

  return res.status(405).end();
}

export function serialiseComment(r, reactions = {}) {
  return {
    id: r.id,
    dealId: r.deal_id,
    parentId: r.parent_id || null,
    body: r.body,
    mentions: r.mentions || [],
    createdBy: r.created_by,
    authorName: r.author_name || r.created_by,
    authorAvatar: r.author_avatar || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at || null,
    reactions,
  };
}
