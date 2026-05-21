import sql from '../db.js';
import { makeId, trimOrNull } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';

// Self-heal: db/migrations/20260520_crm_email_templates.sql creates this table
// but is applied manually in Neon. If a deploy went out before that step, every
// query below 500s with 'relation "crm_email_templates" does not exist'. The
// CREATE is idempotent and module-level cached so we only pay for it on the
// first templates request per cold start. Same pattern as ensureSignatureColumns.
let templatesTableEnsured = null;
function ensureEmailTemplatesTable() {
  if (templatesTableEnsured) return templatesTableEnsured;
  templatesTableEnsured = (async () => {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS crm_email_templates (
          id         TEXT        PRIMARY KEY,
          name       TEXT        NOT NULL,
          subject    TEXT,
          body_html  TEXT,
          body_text  TEXT,
          stage      TEXT,
          visibility TEXT        NOT NULL DEFAULT 'team',
          created_by TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      // Self-heal the column for tables created before visibility existed.
      await sql`ALTER TABLE crm_email_templates ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'team'`;
    } catch (err) {
      templatesTableEnsured = null; // retry next request on a transient failure
      console.warn('[crm templates] ensureEmailTemplatesTable failed', err.message);
    }
  })();
  return templatesTableEnsured;
}

export async function templatesRoute(req, res, id, action, user) {
  await ensureEmailTemplatesTable();
  if (!id) {
    if (req.method === 'GET') {
      // Visibility scope: team templates are shown to everyone; private
      // templates only to their owner. Optional ?stage=… filter additionally
      // limits to templates pinned to that stage or stage-agnostic (NULL).
      const stage = trimOrNull(req.query.stage);
      const rows = stage
        ? await sql`
            SELECT id, name, subject, body_html, body_text, stage, visibility, created_by, created_at, updated_at
            FROM crm_email_templates
            WHERE (stage = ${stage} OR stage IS NULL)
              AND (visibility = 'team' OR created_by = ${user.email})
            ORDER BY stage DESC NULLS LAST, name ASC
          `
        : await sql`
            SELECT id, name, subject, body_html, body_text, stage, visibility, created_by, created_at, updated_at
            FROM crm_email_templates
            WHERE visibility = 'team' OR created_by = ${user.email}
            ORDER BY name ASC
          `;
      return res.status(200).json(rows.map(serialiseTemplate));
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const name = trimOrNull(body.name);
      if (!name) return res.status(400).json({ error: 'name is required' });
      const visibility = body.visibility === 'private' ? 'private' : 'team';
      const newId = body.id || makeId('tpl');
      await sql`
        INSERT INTO crm_email_templates (id, name, subject, body_html, body_text, stage, visibility, created_by)
        VALUES (${newId}, ${name}, ${trimOrNull(body.subject)},
                ${trimOrNull(body.bodyHtml)}, ${trimOrNull(body.bodyText)},
                ${trimOrNull(body.stage)}, ${visibility}, ${user.email})
      `;
      const rows = await sql`
        SELECT id, name, subject, body_html, body_text, stage, visibility, created_by, created_at, updated_at
        FROM crm_email_templates WHERE id = ${newId}
      `;
      return res.status(201).json(serialiseTemplate(rows[0]));
    }
    return res.status(405).end();
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const cur = (await sql`
      SELECT id, name, subject, body_html, body_text, stage, visibility, created_by, created_at, updated_at
      FROM crm_email_templates WHERE id = ${id}
    `)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    // A private template can only be edited by its owner.
    if (cur.visibility === 'private' && cur.created_by !== user.email) {
      return res.status(403).json({ error: 'This is another user\'s private template' });
    }
    const next = {
      name:       'name'       in body ? (trimOrNull(body.name) || cur.name) : cur.name,
      subject:    'subject'    in body ? trimOrNull(body.subject) : cur.subject,
      body_html:  'bodyHtml'   in body ? trimOrNull(body.bodyHtml) : cur.body_html,
      body_text:  'bodyText'   in body ? trimOrNull(body.bodyText) : cur.body_text,
      stage:      'stage'      in body ? trimOrNull(body.stage) : cur.stage,
      visibility: 'visibility' in body ? (body.visibility === 'private' ? 'private' : 'team') : cur.visibility,
    };
    await sql`
      UPDATE crm_email_templates SET
        name = ${next.name},
        subject = ${next.subject},
        body_html = ${next.body_html},
        body_text = ${next.body_text},
        stage = ${next.stage},
        visibility = ${next.visibility},
        updated_at = NOW()
      WHERE id = ${id}
    `;
    const rows = await sql`
      SELECT id, name, subject, body_html, body_text, stage, visibility, created_by, created_at, updated_at
      FROM crm_email_templates WHERE id = ${id}
    `;
    return res.status(200).json(serialiseTemplate(rows[0]));
  }

  if (req.method === 'DELETE') {
    const cur = (await sql`SELECT visibility, created_by FROM crm_email_templates WHERE id = ${id}`)[0];
    if (!cur) return res.status(200).json({ ok: true });
    // Owners can always delete their own private template. Deleting a team
    // template (or someone else's) still requires the manage permission.
    const isOwnPrivate = cur.visibility === 'private' && cur.created_by === user.email;
    if (!isOwnPrivate && !hasPermission(await getRole(user.role), 'templates.manage')) {
      return res.status(403).json({ error: 'You do not have permission to delete this template' });
    }
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
    visibility: r.visibility || 'team',
    createdBy: r.created_by || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
