// Admin CRUD for The Explainer Video Crash Course (Admin → Crash course).
// Gated on settings.manage — it's a workspace-wide marketing asset, not
// per-deal content.
//
// NAMING: this file and the schema say "module" (course_modules, module_number);
// every string a human reads says "video". They're the same thing — there are
// simply eight videos, and "module" is e-learning jargon nobody here uses. The
// split is deliberate, not a half-finished rename: the table is already live in
// production, so renaming it would cost a migration purely to fix wording.
//
//   GET    /api/crm/course                → list every module (published or not)
//   POST   /api/crm/course                → create a module
//   POST   /api/crm/course/upload-token   → mint a client-upload token
//   PATCH  /api/crm/course/:id            → edit metadata / publish / reorder
//   GET    /api/crm/course/:id/video      → same-origin byte relay (for PosterPicker)
//   POST   /api/crm/course/:id/video      → attach a freshly-uploaded blob
//   POST   /api/crm/course/:id/poster     → set the thumbnail (base64 JPEG)
//   DELETE /api/crm/course/:id            → delete the module and its blob
//
// Videos go to the PUBLIC revision blob store, the same one draft cuts use, so
// they stream from a <video> tag. Access control is therefore about who is told
// the URL, not about the URL itself — see api/_lib/course/serialisers.js.

import { handleUpload } from '@vercel/blob/client';
import { del } from '@vercel/blob';
import sql from '../db.js';
import { streamBlob } from '../blobStream.js';
import { makeId, trimOrNull, numberOrNull } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { ensureCourseTables } from '../course/db.js';
import { adminModule } from '../course/serialisers.js';

const REVISION_BLOB_TOKEN =
  process.env.REVISION_BLOB_READ_WRITE_TOKEN || process.env.REVIEW_BLOB_READ_WRITE_TOKEN;

const MAX_POSTER_BYTES = 1024 * 1024;               // matches the portal library
const POSTER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Slugs are part of the public URL and of the funnel's event rows, so they're
// restricted and stable: set once at create, never rewritten by a title edit.
const slugify = (s) =>
  String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

export async function courseRoute(req, res, id, action, user) {
  await ensureCourseTables();

  const role = await getRole(user.role);
  if (!hasPermission(role, 'settings.manage')) {
    return res.status(403).json({ error: 'You do not have permission to manage the course' });
  }

  // `upload-token` arrives in the id slot (POST /api/crm/course/upload-token),
  // so it has to be claimed before id is treated as a module id — the same
  // shape xero-contacts uses.
  if (id === 'upload-token') {
    if (req.method !== 'POST') return res.status(405).end();
    return uploadToken(req, res);
  }

  if (!id) {
    if (req.method === 'GET') return listModules(res);
    if (req.method === 'POST') return createModule(req, res);
    return res.status(405).end();
  }

  const [existing] = await sql`SELECT * FROM course_modules WHERE id = ${id}`;
  if (!existing) return res.status(404).json({ error: 'Video not found' });

  if (action === 'video')  return attachVideo(req, res, existing);
  if (action === 'poster') return setPoster(req, res, existing);
  if (req.method === 'PATCH')  return patchModule(req, res, existing);
  if (req.method === 'DELETE') return deleteModule(res, existing);
  return res.status(405).end();
}

async function listModules(res) {
  const rows = await sql`
    SELECT * FROM course_modules
     ORDER BY COALESCE(sort_order, module_number), module_number`;
  return res.status(200).json(rows.map(adminModule));
}

async function createModule(req, res) {
  const body = req.body || {};
  const title = trimOrNull(body.title);
  if (!title) return res.status(400).json({ error: 'title is required' });

  const slug = slugify(body.slug || title);
  if (!slug) return res.status(400).json({ error: 'Could not derive a slug from that title' });

  const [clash] = await sql`SELECT 1 FROM course_modules WHERE slug = ${slug}`;
  if (clash) return res.status(409).json({ error: 'A video with that web address already exists' });

  // Default to the end of the running order rather than making the caller
  // work it out.
  const [{ next }] = await sql`
    SELECT COALESCE(MAX(module_number), 0) + 1 AS next FROM course_modules`;
  const moduleNumber = numberOrNull(body.moduleNumber) ?? next;

  const [row] = await sql`
    INSERT INTO course_modules (id, slug, module_number, title, subtitle, description, free, published)
    VALUES (${makeId('cmod')}, ${slug}, ${moduleNumber}, ${title},
            ${trimOrNull(body.subtitle)}, ${trimOrNull(body.description)},
            ${body.free === true}, FALSE)
    RETURNING *`;
  return res.status(201).json(adminModule(row));
}

async function patchModule(req, res, existing) {
  const b = req.body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);

  // Publishing a module with no video attached would put a dead tile on the
  // public page — the one mistake worth blocking outright.
  const willPublish = has('published') ? b.published === true : existing.published;
  if (willPublish && !existing.blob_url) {
    return res.status(400).json({ error: 'Upload the video file before publishing it' });
  }

  const [row] = await sql`
    UPDATE course_modules SET
      title         = ${has('title') ? (trimOrNull(b.title) ?? existing.title) : existing.title},
      subtitle      = ${has('subtitle') ? trimOrNull(b.subtitle) : existing.subtitle},
      description   = ${has('description') ? trimOrNull(b.description) : existing.description},
      module_number = ${has('moduleNumber') ? (numberOrNull(b.moduleNumber) ?? existing.module_number) : existing.module_number},
      sort_order    = ${has('sortOrder') ? numberOrNull(b.sortOrder) : existing.sort_order},
      free          = ${has('free') ? b.free === true : existing.free},
      published     = ${willPublish},
      updated_at    = NOW()
     WHERE id = ${existing.id}
    RETURNING *`;

  // Exactly one module is the free one. Enforced here rather than by a partial
  // unique index so that ticking a new module silently unticks the old one,
  // which is what the admin means by the click.
  if (has('free') && b.free === true) {
    await sql`UPDATE course_modules SET free = FALSE, updated_at = NOW()
               WHERE id <> ${existing.id} AND free`;
  }
  return res.status(200).json(adminModule(row));
}

// Mints a client-upload token against the public revision blob store. The
// caller is already authenticated and permission-checked above.
//
// Deliberately no `maximumSizeInBytes` and no `allowedContentTypes`: either one
// makes the multipart-create call 400 (see api/revisions/[action].js). And no
// `onUploadCompleted` — it never fires on localhost, so the row is written by
// the separate /video POST once the browser upload resolves.
async function uploadToken(req, res) {
  if (!REVISION_BLOB_TOKEN) return res.status(503).json({ error: 'File storage not configured' });
  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      token: REVISION_BLOB_TOKEN,
      onBeforeGenerateToken: async () => ({ addRandomSuffix: true }),
    });
    return res.status(200).json(jsonResponse);
  } catch (err) {
    if (res.headersSent) return;
    return res.status(400).json({ error: err?.message || 'Upload authorisation failed' });
  }
}

// Records a freshly-uploaded video against a module, replacing whatever was
// there. The old blob is deleted best-effort: a leaked blob costs pennies, a
// failed replace costs the admin their afternoon.
//
// GET on the same path relays the bytes through this origin. PosterPicker
// captures a frame onto a canvas, and a canvas taints on a cross-origin video —
// so it can't use the blob URL directly even though that URL is public.
// Authentication rides the sq_session cookie, which a plain <video src> sends.
async function attachVideo(req, res, existing) {
  if (req.method === 'GET') {
    if (!existing.blob_url) return res.status(404).json({ error: 'No video file uploaded yet' });
    return streamBlob(req, res, existing.blob_url, existing.mime_type || 'video/mp4');
  }
  if (req.method !== 'POST') return res.status(405).end();
  const b = req.body || {};
  const blobUrl = trimOrNull(b.blobUrl);
  if (!blobUrl) return res.status(400).json({ error: 'blobUrl is required' });

  const [row] = await sql`
    UPDATE course_modules SET
      blob_url         = ${blobUrl},
      blob_pathname    = ${trimOrNull(b.blobPathname)},
      mime_type        = ${trimOrNull(b.mimeType)},
      size_bytes       = ${numberOrNull(b.sizeBytes)},
      duration_seconds = ${numberOrNull(b.durationSeconds)},
      updated_at       = NOW()
     WHERE id = ${existing.id}
    RETURNING *`;

  if (existing.blob_url && existing.blob_url !== blobUrl) {
    try { await del(existing.blob_url, { token: REVISION_BLOB_TOKEN }); }
    catch (err) { console.warn('[course] old blob delete failed', err.message); }
  }
  return res.status(200).json(adminModule(row));
}

// The thumbnail, captured from a frame of the video itself by PosterPicker.
async function setPoster(req, res, existing) {
  if (req.method !== 'POST') return res.status(405).end();
  const poster = trimOrNull((req.body || {}).poster);
  if (!poster) {
    const [cleared] = await sql`
      UPDATE course_modules SET poster = NULL, poster_updated_at = NULL, updated_at = NOW()
       WHERE id = ${existing.id} RETURNING *`;
    return res.status(200).json(adminModule(cleared));
  }

  const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(poster);
  if (!m || !POSTER_TYPES.includes(m[1].toLowerCase())) {
    return res.status(400).json({ error: 'Thumbnail must be a JPEG, PNG or WebP image' });
  }
  // Measure the decoded bytes, not the base64 string — base64 is ~33% larger,
  // so checking the string would reject legitimate images near the limit.
  if (Buffer.from(m[2].replace(/\s/g, ''), 'base64').length > MAX_POSTER_BYTES) {
    return res.status(413).json({ error: 'Thumbnail is too large (1MB max)' });
  }

  const [row] = await sql`
    UPDATE course_modules SET poster = ${poster}, poster_updated_at = NOW(), updated_at = NOW()
     WHERE id = ${existing.id} RETURNING *`;
  return res.status(200).json(adminModule(row));
}

async function deleteModule(res, existing) {
  await sql`DELETE FROM course_modules WHERE id = ${existing.id}`;
  if (existing.blob_url) {
    try { await del(existing.blob_url, { token: REVISION_BLOB_TOKEN }); }
    catch (err) { console.warn('[course] blob delete failed', err.message); }
  }
  return res.status(204).end();
}
