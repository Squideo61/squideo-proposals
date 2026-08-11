// Public, unauthenticated API for the Free 6-Min Video Guide.
//
// Serves the /course landing page: the module list, the free module's bytes,
// poster images, and the anonymous funnel events that measure landing → play →
// signup. Everything here is readable by the world, by design.
//
//   GET  /api/course?action=public          — published module metadata
//   GET  /api/course?action=stream&slug=…   — bytes, FREE published module only
//   GET  /api/course?action=poster&slug=…   — poster image bytes
//   POST /api/course?action=event           — anonymous funnel event
//
// The gating rule lives in exactly two places and nowhere else: `publicModule()`
// cannot express a blob URL (api/_lib/course/serialisers.js), and `streamRoute`
// re-reads `free AND published` from the database. A locked module's bytes are
// served by the portal's own download route, behind a session.

import sql from './_lib/db.js';
import { cors } from './_lib/middleware.js';
import { makeId } from './_lib/crm/shared.js';
import { ensureCourseTables } from './_lib/course/db.js';
import { publicModule } from './_lib/course/serialisers.js';
// Generic "base64 image data URL → bytes"; it lives in logo.js because that's
// where the first caller was, but there's nothing logo-specific about it.
import { decodeLogo as decodeImageDataUrl } from './_lib/portal/logo.js';

const EVENT_KEYS = new Set(['page_view', 'play', 'progress', 'signup_open']);

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = String(req.query.action || 'public');
  try {
    await ensureCourseTables();
    if (action === 'public') return await publicRoute(req, res);
    if (action === 'stream') return await streamRoute(req, res);
    if (action === 'poster') return await posterRoute(req, res);
    if (action === 'event')  return await eventRoute(req, res);
    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('[course] unhandled', { action, method: req.method, err });
    return res.status(500).json({ error: 'Server error' });
  }
}

// ── The module list ──────────────────────────────────────────────────────────
// Unpublished modules are invisible: that's what lets the page go live with
// module 1 while the other seven are still being uploaded.
async function publicRoute(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const rows = await sql`
    SELECT slug, module_number, title, subtitle, description,
           duration_seconds, poster, poster_updated_at, free
      FROM course_modules
     WHERE published
     ORDER BY COALESCE(sort_order, module_number), module_number
  `;
  const modules = rows.map(publicModule);
  const totalSeconds = rows.reduce((n, r) => n + (r.duration_seconds || 0), 0);
  const freeSlugs = modules.filter((m) => m.free).map((m) => m.slug);

  // A short cache is worth having — this is the payload every anonymous visitor
  // fetches — but it must stay short, or publishing a module looks broken.
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
  return res.status(200).json({
    modules,
    totalSeconds,
    moduleCount: modules.length,
    // Several videos are free (currently 1-3), so this is a list. The page
    // plays them in order and only then shows the signup.
    freeSlugs,
    freeSeconds: rows.filter((r) => r.free).reduce((n, r) => n + (r.duration_seconds || 0), 0),
  });
}

// ── Playback, free module only ───────────────────────────────────────────────
async function streamRoute(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const slug = req.query.slug ? String(req.query.slug) : null;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  // `free AND published` is re-read from the database on every request rather
  // than trusted from anything the client sent.
  const rows = await sql`
    SELECT blob_url FROM course_modules
     WHERE slug = ${slug} AND free AND published AND blob_url IS NOT NULL
     LIMIT 1
  `;
  // A locked module and a nonexistent one give the same answer — no oracle for
  // which slugs exist.
  if (!rows.length) return res.status(404).json({ error: 'Not found' });

  res.setHeader('Location', rows[0].blob_url);
  return res.status(302).end();
}

// ── Poster images ────────────────────────────────────────────────────────────
// Posters are public for every published module, locked or not: the grid shows
// all eight thumbnails, and a still frame gives nothing away.
async function posterRoute(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const slug = req.query.slug ? String(req.query.slug) : null;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  const rows = await sql`
    SELECT poster FROM course_modules
     WHERE slug = ${slug} AND published AND poster IS NOT NULL LIMIT 1
  `;
  const decoded = rows.length ? decodeImageDataUrl(rows[0].poster) : null;
  if (!decoded) return res.status(404).end();

  res.setHeader('Content-Type', decoded.contentType);
  res.setHeader('Content-Length', decoded.bytes.length);
  // The URL carries a ?v= stamped from poster_updated_at, so a replacement
  // gets a new URL and this can be cached hard.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return res.status(200).end(decoded.bytes);
}

// ── Anonymous funnel events ──────────────────────────────────────────────────
// The pre-signup half of the funnel. `visitorKey` is a random per-tab value the
// page keeps in sessionStorage — no cookie, nothing that identifies a person,
// so this needs no consent banner.
//
// Always 204, whatever happens: analytics must never be something a visitor can
// notice failing, and must never block the page.
async function eventRoute(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const eventKey = String(body.eventKey || '');
    if (!EVENT_KEYS.has(eventKey)) return res.status(204).end();

    const slug = body.slug ? String(body.slug).slice(0, 80) : null;
    const moduleId = slug
      ? (await sql`SELECT id FROM course_modules WHERE slug = ${slug} LIMIT 1`)[0]?.id || null
      : null;

    await sql`
      INSERT INTO course_events (id, visitor_key, event_key, module_id, detail, country, city, user_agent)
      VALUES (${makeId('cev')},
              ${body.visitorKey ? String(body.visitorKey).slice(0, 64) : null},
              ${eventKey}, ${moduleId},
              ${body.detail ? JSON.stringify(body.detail).slice(0, 2000) : null}::jsonb,
              ${req.headers['x-vercel-ip-country'] || null},
              ${req.headers['x-vercel-ip-city'] || null},
              ${String(req.headers['user-agent'] || '').slice(0, 400) || null})
    `;
  } catch (err) {
    console.warn('[course] event drop', err.message);
  }
  return res.status(204).end();
}
