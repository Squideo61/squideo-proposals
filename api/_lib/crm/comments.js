import sql from '../db.js';
import { trimOrNull } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';

const ALLOWED_REACTIONS = ['👍', '👎', '❤️', '😂', '🎉', '👀'];

export async function commentsRoute(req, res, id, action, user) {
  if (!id) return res.status(404).json({ error: 'Comment id required' });

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const text = trimOrNull(body.body);
    if (!text) return res.status(400).json({ error: 'body is required' });
    const mentions = Array.isArray(body.mentions) ? body.mentions.filter(m => typeof m === 'string') : [];
    const rows = await sql`SELECT created_by FROM deal_comments WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].created_by !== user.email && !hasPermission(await getRole(user.role), 'comments.manage_all'))
      return res.status(403).json({ error: 'Forbidden' });
    await sql`
      UPDATE deal_comments SET body = ${text}, mentions = ${mentions}, updated_at = NOW()
      WHERE id = ${id}
    `;
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
