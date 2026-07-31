import sql from '../db.js';
import { makeId, trimOrNull } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';

// Self-heal: db/migrations/20260520_crm_email_templates.sql creates this table
// but is applied manually in Neon. If a deploy went out before that step, every
// query below 500s with 'relation "crm_email_templates" does not exist'. The
// CREATE is idempotent and module-level cached so we only pay for it on the
// first templates request per cold start. Same pattern as ensureSignatureColumns.
// The starting point for "Invite to portal", which opens the composer prefilled
// rather than firing the system email. It lives in the normal templates table so
// it's edited the same way as any other — nothing here is special-cased.
//
// {{…}} placeholders are filled by the CRM when it opens the composer; see
// src/lib/portalInviteEmail.js for the list. ON CONFLICT DO NOTHING on a fixed
// id means an edited copy is never overwritten, and a deleted one stays deleted
// (the CRM falls back to a terse built-in).
export const PORTAL_INVITE_TEMPLATE_ID = 'tpl_portal_invite';

const PORTAL_INVITE_BODY = `<p>Hi {{first_name}},</p>
<p>I've set up your Squideo client portal — it's where you'll find everything for your projects in one place: live progress, videos to review and sign off, your finished video library, and any documents we need from you.</p>
<p><a href="{{portal_link}}">Set up your login here</a></p>
<p>It only takes a moment, and you can invite the rest of your team once you're in.</p>
<p>Any questions, just reply to this email.</p>`;

async function seedPortalInviteTemplate() {
  await sql`
    INSERT INTO crm_email_templates (id, name, subject, body_html, visibility, created_by)
    VALUES (${PORTAL_INVITE_TEMPLATE_ID}, 'Client portal invite',
            'Your Squideo client portal is ready', ${PORTAL_INVITE_BODY}, 'team', NULL)
    ON CONFLICT (id) DO NOTHING
  `;
}

// "Submit to client for review" opens the same kind of editable draft as the
// portal invite — the producer writes the covering email rather than the client
// getting a bare system notification. Two templates because a storyboard round
// and a cut of the film ask for different things.
//
// Placeholders filled when the composer opens: {{first_name}} {{name}}
// {{email}} {{company}} {{video_title}} {{project_title}} {{review_link}}
// {{version}} {{sender}}. See src/lib/reviewEmail.js.
export const REVIEW_VIDEO_TEMPLATE_ID = 'tpl_review_video';
export const REVIEW_STORYBOARD_TEMPLATE_ID = 'tpl_review_storyboard';

const REVIEW_VIDEO_BODY = `<p>Hi {{first_name}},</p>
<p>The latest cut of <strong>{{video_title}}</strong> is ready for you to watch.</p>
<p><a href="{{review_link}}">Watch it and leave your feedback here</a></p>
<p>You can pause at any point and leave a comment on that exact moment, which makes it much easier for us to pick up than a written list. When you're happy with it, hit approve and we'll get it finished.</p>
<p>Any questions, just reply to this email.</p>`;

const REVIEW_STORYBOARD_BODY = `<p>Hi {{first_name}},</p>
<p>The storyboard for <strong>{{video_title}}</strong> is ready for you to look over.</p>
<p><a href="{{review_link}}">View the storyboard and leave your feedback here</a></p>
<p>You can comment on any individual frame, so we know exactly which bit you mean. Once you've approved it we'll start production.</p>
<p>Any questions, just reply to this email.</p>`;

async function seedReviewTemplates() {
  await sql`
    INSERT INTO crm_email_templates (id, name, subject, body_html, visibility, created_by)
    VALUES (${REVIEW_VIDEO_TEMPLATE_ID}, 'Video ready to review',
            '{{video_title}} — ready for you to review', ${REVIEW_VIDEO_BODY}, 'team', NULL)
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO crm_email_templates (id, name, subject, body_html, visibility, created_by)
    VALUES (${REVIEW_STORYBOARD_TEMPLATE_ID}, 'Storyboard ready to review',
            '{{video_title}} — your storyboard is ready to review', ${REVIEW_STORYBOARD_BODY}, 'team', NULL)
    ON CONFLICT (id) DO NOTHING
  `;
}

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
      await seedPortalInviteTemplate();
      await seedReviewTemplates();
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
