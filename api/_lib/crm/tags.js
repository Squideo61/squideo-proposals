// Contact tags — CRUD plus the helper other code uses to apply one.
//
//   GET    /api/crm/tags            → every tag + its contact count
//   POST   /api/crm/tags            → create (label + colour)
//   PATCH  /api/crm/tags/:id        → rename / recolour / reorder
//   DELETE /api/crm/tags/:id        → delete (409 on a system tag)
//
// Applying and removing a tag lives on the contact, next to the existing
// /contacts/:id/companies sub-resource:
//   POST   /api/crm/contacts/:id/tags          { tagId | slug }
//   DELETE /api/crm/contacts/:id/tags/:tagId

import sql from '../db.js';
import { makeId, trimOrNull } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';

const step = async (label, fn) => {
  try { await fn(); } catch (err) { console.warn('[ensureCrmTagTables] ' + label, err.message); }
};

let tagTablesEnsured = null;
export function ensureCrmTagTables() {
  if (tagTablesEnsured) return tagTablesEnsured;
  tagTablesEnsured = (async () => {
    await step('crm_tags', async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS crm_tags (
          id         TEXT        PRIMARY KEY,
          slug       TEXT        NOT NULL UNIQUE,
          label      TEXT        NOT NULL,
          colour     TEXT        NOT NULL DEFAULT '#2BB8E6',
          kind       TEXT        NOT NULL DEFAULT 'contact',
          system     BOOLEAN     NOT NULL DEFAULT FALSE,
          sort_order INTEGER,
          created_by TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
    });
    await step('contact_tags', async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS contact_tags (
          contact_id TEXT        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          tag_id     TEXT        NOT NULL REFERENCES crm_tags(id) ON DELETE CASCADE,
          applied_by TEXT,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (contact_id, tag_id)
        )`;
      await sql`CREATE INDEX IF NOT EXISTS contact_tags_tag_idx ON contact_tags(tag_id)`;
    });
  })();
  return tagTablesEnsured;
}

const slugify = (s) =>
  String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

const HEX = /^#[0-9a-f]{6}$/i;
const cleanColour = (c) => (HEX.test(String(c || '')) ? String(c) : '#2BB8E6');

export function serialiseTag(row) {
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    colour: row.colour,
    system: !!row.system,
    sortOrder: row.sort_order ?? null,
    contactCount: row.contact_count != null ? Number(row.contact_count) : 0,
  };
}

// Find-or-create by slug, then apply. Used by the course signup and completion
// paths, so it is BEST-EFFORT: a tagging failure must never cost someone the
// account they just created, and never be the reason a signup 500s.
export async function applyTag(contactId, slug, { label, colour, system = true, by = null } = {}) {
  if (!contactId || !slug) return null;
  try {
    await ensureCrmTagTables();
    const [tag] = await sql`
      INSERT INTO crm_tags (id, slug, label, colour, system)
      VALUES (${makeId('tg')}, ${slug}, ${label || slug}, ${cleanColour(colour)}, ${system})
      ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
      RETURNING id
    `;
    if (!tag) return null;
    await sql`
      INSERT INTO contact_tags (contact_id, tag_id, applied_by)
      VALUES (${contactId}, ${tag.id}, ${by})
      ON CONFLICT (contact_id, tag_id) DO NOTHING
    `;
    return tag.id;
  } catch (err) {
    console.warn('[tags] applyTag failed', slug, err.message);
    return null;
  }
}

export async function tagsRoute(req, res, id, action, user) {
  await ensureCrmTagTables();

  const role = await getRole(user.role);
  // Reading tags is part of reading contacts; creating and editing them shapes
  // everyone's view of the CRM, so that needs the contacts-management right.
  const canManage = hasPermission(role, 'contacts.manage_all') || hasPermission(role, 'settings.manage');

  if (!id) {
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT t.*, COUNT(ct.contact_id) AS contact_count
          FROM crm_tags t
          LEFT JOIN contact_tags ct ON ct.tag_id = t.id
         GROUP BY t.id
         ORDER BY t.sort_order NULLS LAST, LOWER(t.label)
      `;
      return res.status(200).json(rows.map(serialiseTag));
    }
    if (req.method === 'POST') {
      if (!canManage) return res.status(403).json({ error: 'You do not have permission to create tags' });
      const label = trimOrNull((req.body || {}).label);
      if (!label) return res.status(400).json({ error: 'Tag name is required' });
      const slug = slugify(label);
      if (!slug) return res.status(400).json({ error: 'That tag name has no usable characters' });

      const [clash] = await sql`SELECT id FROM crm_tags WHERE slug = ${slug}`;
      if (clash) return res.status(409).json({ error: 'A tag with that name already exists' });

      const [row] = await sql`
        INSERT INTO crm_tags (id, slug, label, colour, created_by)
        VALUES (${makeId('tg')}, ${slug}, ${label}, ${cleanColour((req.body || {}).colour)}, ${user.email})
        RETURNING *`;
      return res.status(201).json(serialiseTag(row));
    }
    return res.status(405).end();
  }

  const [existing] = await sql`SELECT * FROM crm_tags WHERE id = ${id}`;
  if (!existing) return res.status(404).json({ error: 'Tag not found' });

  if (req.method === 'PATCH') {
    if (!canManage) return res.status(403).json({ error: 'You do not have permission to edit tags' });
    const b = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    // The SLUG is never rewritten by a rename. Code applies tags by slug, so
    // renaming "Course signup" to something else must not stop the course from
    // tagging its signups.
    const [row] = await sql`
      UPDATE crm_tags SET
        label      = ${has('label') ? (trimOrNull(b.label) ?? existing.label) : existing.label},
        colour     = ${has('colour') ? cleanColour(b.colour) : existing.colour},
        sort_order = ${has('sortOrder') ? (Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : null) : existing.sort_order}
       WHERE id = ${id}
      RETURNING *`;
    return res.status(200).json(serialiseTag(row));
  }

  if (req.method === 'DELETE') {
    if (!canManage) return res.status(403).json({ error: 'You do not have permission to delete tags' });
    if (existing.system) {
      return res.status(409).json({
        error: `"${existing.label}" is applied automatically by the CRM, so it can't be deleted. You can rename or recolour it.`,
      });
    }
    await sql`DELETE FROM crm_tags WHERE id = ${id}`;   // contact_tags cascades
    return res.status(204).end();
  }

  return res.status(405).end();
}

// POST/DELETE /api/crm/contacts/:id/tags — called from contactsRoute so the
// permission check and contact lookup there are reused.
export async function contactTagsRoute(req, res, contactId, tagId, user) {
  await ensureCrmTagTables();

  if (req.method === 'POST') {
    const body = req.body || {};
    const wanted = trimOrNull(body.tagId);
    const slug = trimOrNull(body.slug);
    let tag = null;
    if (wanted) [tag] = await sql`SELECT id FROM crm_tags WHERE id = ${wanted}`;
    else if (slug) [tag] = await sql`SELECT id FROM crm_tags WHERE slug = ${slug}`;
    if (!tag) return res.status(404).json({ error: 'Tag not found' });

    await sql`
      INSERT INTO contact_tags (contact_id, tag_id, applied_by)
      VALUES (${contactId}, ${tag.id}, ${user.email})
      ON CONFLICT (contact_id, tag_id) DO NOTHING
    `;
    return res.status(200).json({ ok: true, tagId: tag.id });
  }

  if (req.method === 'DELETE') {
    if (!tagId) return res.status(400).json({ error: 'tagId required' });
    await sql`DELETE FROM contact_tags WHERE contact_id = ${contactId} AND tag_id = ${tagId}`;
    return res.status(204).end();
  }

  return res.status(405).end();
}
