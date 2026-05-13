import sql from '../db.js';
import { makeId, trimOrNull } from './shared.js';

export async function templatesRoute(req, res, id, action, user) {
  if (!id) {
    if (req.method === 'GET') {
      // Optional ?stage=… filter — returns templates either pinned to that
      // stage or stage-agnostic (NULL stage = always-shown).
      const stage = trimOrNull(req.query.stage);
      const rows = stage
        ? await sql`
            SELECT id, name, subject, body_html, body_text, stage, created_by, created_at, updated_at
            FROM crm_email_templates
            WHERE stage = ${stage} OR stage IS NULL
            ORDER BY stage DESC NULLS LAST, name ASC
          `
        : await sql`
            SELECT id, name, subject, body_html, body_text, stage, created_by, created_at, updated_at
            FROM crm_email_templates
            ORDER BY name ASC
          `;
      return res.status(200).json(rows.map(serialiseTemplate));
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const name = trimOrNull(body.name);
      if (!name) return res.status(400).json({ error: 'name is required' });
      const newId = body.id || makeId('tpl');
      await sql`
        INSERT INTO crm_email_templates (id, name, subject, body_html, body_text, stage, created_by)
        VALUES (${newId}, ${name}, ${trimOrNull(body.subject)},
                ${trimOrNull(body.bodyHtml)}, ${trimOrNull(body.bodyText)},
                ${trimOrNull(body.stage)}, ${user.email})
      `;
      const rows = await sql`
        SELECT id, name, subject, body_html, body_text, stage, created_by, created_at, updated_at
        FROM crm_email_templates WHERE id = ${newId}
      `;
      return res.status(201).json(serialiseTemplate(rows[0]));
    }
    return res.status(405).end();
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const cur = (await sql`
      SELECT id, name, subject, body_html, body_text, stage, created_by, created_at, updated_at
      FROM crm_email_templates WHERE id = ${id}
    `)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const next = {
      name:      'name'     in body ? (trimOrNull(body.name) || cur.name) : cur.name,
      subject:   'subject'  in body ? trimOrNull(body.subject) : cur.subject,
      body_html: 'bodyHtml' in body ? trimOrNull(body.bodyHtml) : cur.body_html,
      body_text: 'bodyText' in body ? trimOrNull(body.bodyText) : cur.body_text,
      stage:     'stage'    in body ? trimOrNull(body.stage) : cur.stage,
    };
    await sql`
      UPDATE crm_email_templates SET
        name = ${next.name},
        subject = ${next.subject},
        body_html = ${next.body_html},
        body_text = ${next.body_text},
        stage = ${next.stage},
        updated_at = NOW()
      WHERE id = ${id}
    `;
    const rows = await sql`
      SELECT id, name, subject, body_html, body_text, stage, created_by, created_at, updated_at
      FROM crm_email_templates WHERE id = ${id}
    `;
    return res.status(200).json(serialiseTemplate(rows[0]));
  }

  if (req.method === 'DELETE') {
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    await sql`DELETE FROM crm_email_templates WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}

export function serialiseTemplate(r) {
  return {
    id: r.id,
    name: r.name,
    subject: r.subject || null,
    bodyHtml: r.body_html || null,
    bodyText: r.body_text || null,
    stage: r.stage || null,
    createdBy: r.created_by || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
