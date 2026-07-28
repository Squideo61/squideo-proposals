// Admin CRUD for the global voiceover-artist catalogue (Admin → Voiceovers).
// The client picks from this catalogue per video in the portal. All routes are
// gated on settings.manage — it's a workspace-wide catalogue, not per-deal.
//
//   GET    /api/crm/voiceovers              → list (both sections, non-archived)
//   POST   /api/crm/voiceovers              → create artist metadata
//   POST   /api/crm/voiceovers/:id/sample   → upload/replace the sample clip (raw body)
//   GET    /api/crm/voiceovers/:id/sample   → stream the clip (staff preview)
//   PATCH  /api/crm/voiceovers/:id          → edit name/description/category/sort
//   DELETE /api/crm/voiceovers/:id          → soft-archive

import sql from '../db.js';
import { makeId, trimOrNull, numberOrNull } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import {
  ensureVoiceoverCatalogue, serialiseArtist, getArtist,
  putArtistSample, streamVoiceoverSample, VOICEOVER_CATEGORIES, VOICEOVER_MIME,
} from '../voiceover.js';

const MAX_SAMPLE_SIZE = 20 * 1024 * 1024; // 20 MB, matching other uploads
const cleanCategory = (c) => (VOICEOVER_CATEGORIES.includes(c) ? c : 'human');

export async function voiceoversRoute(req, res, id, action, user) {
  await ensureVoiceoverCatalogue();

  const role = await getRole(user.role);
  const manage = hasPermission(role, 'voiceovers.manage') || hasPermission(role, 'settings.manage');
  if (!manage) return res.status(403).json({ error: 'You do not have permission to manage the voiceover catalogue' });

  // ── Collection: list + create ──────────────────────────────────────────────
  if (!id) {
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT * FROM voiceover_artists
         WHERE archived_at IS NULL
         ORDER BY category, sort_order, created_at`;
      return res.status(200).json(rows.map(serialiseArtist));
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const name = trimOrNull(body.name);
      if (!name) return res.status(400).json({ error: 'name is required' });
      const newId = makeId('voart');
      const [row] = await sql`
        INSERT INTO voiceover_artists (id, category, name, description, sort_order, created_by)
        VALUES (${newId}, ${cleanCategory(body.category)}, ${name},
                ${trimOrNull(body.description)}, ${numberOrNull(body.sortOrder) ?? 0}, ${user.email})
        RETURNING *`;
      return res.status(201).json(serialiseArtist(row));
    }
    return res.status(405).end();
  }

  // ── Sample upload / preview ────────────────────────────────────────────────
  if (action === 'sample') {
    const artist = await getArtist(id);
    if (!artist) return res.status(404).json({ error: 'Artist not found' });

    if (req.method === 'GET') {
      return streamVoiceoverSample(req, res, artist);
    }
    if (req.method === 'POST') {
      const rawName = decodeURIComponent(req.headers['x-filename'] || 'sample');
      const ext = (rawName.split('.').pop() || '').toLowerCase();
      if (!VOICEOVER_MIME[ext]) {
        return res.status(415).json({ error: `Unsupported audio type. Use ${Object.keys(VOICEOVER_MIME).join(', ')}.` });
      }
      let buf = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : null;
      if (!buf) {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        buf = Buffer.concat(chunks);
      }
      if (!buf || buf.length === 0) return res.status(400).json({ error: 'No file data received' });
      if (buf.length > MAX_SAMPLE_SIZE) return res.status(413).json({ error: 'File too large (max 20 MB)' });
      const row = await putArtistSample(id, buf, { filename: rawName, ext });
      return res.status(200).json(serialiseArtist(row));
    }
    return res.status(405).end();
  }

  // ── Single artist: edit + archive ──────────────────────────────────────────
  if (!action) {
    if (req.method === 'PATCH') {
      const body = req.body || {};
      const cur = await getArtist(id);
      if (!cur) return res.status(404).json({ error: 'Artist not found' });
      const next = {
        category:    'category'    in body ? cleanCategory(body.category) : cur.category,
        name:        'name'        in body ? (trimOrNull(body.name) || cur.name) : cur.name,
        description: 'description' in body ? trimOrNull(body.description) : cur.description,
        sort_order:  'sortOrder'   in body ? (numberOrNull(body.sortOrder) ?? cur.sort_order) : cur.sort_order,
      };
      const [row] = await sql`
        UPDATE voiceover_artists
           SET category = ${next.category}, name = ${next.name},
               description = ${next.description}, sort_order = ${next.sort_order}, updated_at = NOW()
         WHERE id = ${id}
         RETURNING *`;
      return res.status(200).json(serialiseArtist(row));
    }
    if (req.method === 'DELETE') {
      // Soft-archive so any video that already locked this artist still resolves
      // its name; it just stops appearing in the client's picker.
      await sql`UPDATE voiceover_artists SET archived_at = NOW(), updated_at = NOW() WHERE id = ${id} AND archived_at IS NULL`;
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  }

  return res.status(404).json({ error: 'Not found' });
}
