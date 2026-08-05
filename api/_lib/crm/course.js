// Admin CRUD for The Explainer Video Planning Crash Course (Admin → Crash course).
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
//   GET    /api/crm/course/:id/poster     → thumbnail bytes (drafts included)
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
import { internalPortalUserIds, internalEmails } from '../internalAccounts.js';
import { adminModule } from '../course/serialisers.js';
// Generic "base64 image data URL → bytes"; it lives in logo.js because that's
// where the first caller was, but there's nothing logo-specific about it.
import { decodeLogo as decodeImageDataUrl } from '../portal/logo.js';

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

  if (id === 'analytics') {
    if (req.method !== 'GET') return res.status(405).end();
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    return courseAnalytics(res, day(req.query.from), day(req.query.to));
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

  // ANY number of videos can be free. This used to force exactly one, on the
  // assumption the course was ~45 minutes and one taster was a fair trade. It
  // came in at 5:48 total, so the gate moved to "videos 1-3 free, 4-8 gated" —
  // asking for an email after 46 seconds reads as stingy, after two minutes of
  // genuine value it reads as earned.
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
//
// GET serves the bytes. The public /api/course poster endpoint can't be reused
// for the admin list because it (correctly) serves published videos only, and
// choosing a thumbnail happens BEFORE publishing — so the admin would be shown
// a broken image for the frame they had just picked. This one is behind
// settings.manage and so has no reason to care whether the video is published.
async function setPoster(req, res, existing) {
  if (req.method === 'GET') {
    const decoded = existing.poster ? decodeImageDataUrl(existing.poster) : null;
    if (!decoded) return res.status(404).end();
    res.setHeader('Content-Type', decoded.contentType);
    res.setHeader('Content-Length', decoded.bytes.length);
    // The URL carries ?v= stamped from poster_updated_at, so a replacement is a
    // new URL and this can be cached hard. `private` — it's behind auth.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    return res.status(200).end(decoded.bytes);
  }
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

// ── Analytics ────────────────────────────────────────────────────────────────
// The funnel, one row per signup, and per-video drop-off.
//
// The hot score is deliberately simple and, more importantly, EXPLAINABLE — a
// score with no visible reasons gets ignored, and a sales team that doesn't
// trust the number won't act on it. Every point that lands is named in
// `reasons`, which the UI shows on hover.
const HOT_THRESHOLD = 60;
const WARM_THRESHOLD = 30;

const FREEMAIL = /@(gmail|googlemail|outlook|hotmail|live|yahoo|ymail|icloud|me|mac|aol|protonmail|proton|gmx|mail|msn|btinternet|sky|virginmedia)\./i;

function hotScore(row) {
  const reasons = [];
  const add = (points, why) => { reasons.push({ points, why }); };
  if (row.quote_count > 0)      add(60, 'Submitted an enquiry');
  if (row.completed_at)         add(20, 'Finished the course');
  if (row.videos_done >= 4)     add(15, `Watched ${row.videos_done} videos`);
  if (row.active_days >= 3)     add(10, `Came back on ${row.active_days} separate days`);
  if (!FREEMAIL.test(row.email || '')) add(5, 'Work email address');
  const score = reasons.reduce((n, r) => n + r.points, 0);
  return {
    score,
    band: score >= HOT_THRESHOLD ? 'hot' : score >= WARM_THRESHOLD ? 'warm' : 'cool',
    reasons,
  };
}

// The public funnel, and how far people actually get through each video.
//
// Two populations, deliberately kept apart rather than added together:
//
//   ANONYMOUS — course_events, keyed by a browser-local visitor key. This is
//     the only view of the people who matter most commercially: the ones who
//     landed, watched the free video and never gave us an email. They are
//     invisible everywhere else in the CRM.
//   SIGNED IN — course_progress, keyed by portal user. Exact to the second,
//     because the portal player reports position rather than milestones.
//
// A visitor key is a browser, not a person. Two devices are two visitors, and
// clearing site data starts a new one — so these are directional numbers for
// comparing videos against each other, not a headcount.
async function courseReach(from, to, skip, ourEmails) {
  const start = from ? from + 'T00:00:00Z' : null;
  const endEx = to ? new Date(new Date(to + 'T00:00:00Z').getTime() + 86400000).toISOString() : null;

  const [funnelRows, videoRows, dayRows] = await Promise.all([
    sql`
      SELECT event_key,
             COUNT(*)::int AS n,
             COUNT(DISTINCT visitor_key)::int AS people
        FROM course_events
       WHERE (${start}::timestamptz IS NULL OR created_at >= ${start})
         AND (${endEx}::timestamptz IS NULL OR created_at < ${endEx})
       GROUP BY event_key
    `.catch(() => []),
    sql`
      SELECT m.id, m.slug, m.module_number, m.title, m.free, m.duration_seconds,
             (SELECT COUNT(DISTINCT e.visitor_key)::int FROM course_events e
               WHERE e.module_id = m.id AND e.event_key = 'play'
                 AND (${start}::timestamptz IS NULL OR e.created_at >= ${start})
                 AND (${endEx}::timestamptz IS NULL OR e.created_at < ${endEx})) AS anon_plays,
             (SELECT COUNT(DISTINCT e.visitor_key)::int FROM course_events e
               WHERE e.module_id = m.id AND e.event_key = 'progress'
                 AND (e.detail->>'pct')::int >= 25
                 AND (${start}::timestamptz IS NULL OR e.created_at >= ${start})
                 AND (${endEx}::timestamptz IS NULL OR e.created_at < ${endEx})) AS anon_25,
             (SELECT COUNT(DISTINCT e.visitor_key)::int FROM course_events e
               WHERE e.module_id = m.id AND e.event_key = 'progress'
                 AND (e.detail->>'pct')::int >= 50
                 AND (${start}::timestamptz IS NULL OR e.created_at >= ${start})
                 AND (${endEx}::timestamptz IS NULL OR e.created_at < ${endEx})) AS anon_50,
             (SELECT COUNT(DISTINCT e.visitor_key)::int FROM course_events e
               WHERE e.module_id = m.id AND e.event_key = 'progress'
                 AND (e.detail->>'pct')::int >= 75
                 AND (${start}::timestamptz IS NULL OR e.created_at >= ${start})
                 AND (${endEx}::timestamptz IS NULL OR e.created_at < ${endEx})) AS anon_75,
             (SELECT COUNT(DISTINCT e.visitor_key)::int FROM course_events e
               WHERE e.module_id = m.id AND e.event_key = 'progress'
                 AND (e.detail->>'ended') = 'true'
                 AND (${start}::timestamptz IS NULL OR e.created_at >= ${start})
                 AND (${endEx}::timestamptz IS NULL OR e.created_at < ${endEx})) AS anon_done,
             (SELECT COUNT(*)::int FROM course_progress p
               WHERE p.module_id = m.id AND p.portal_user_id <> ALL(${skip})
                 AND (${start}::timestamptz IS NULL OR p.last_viewed_at >= ${start})
                 AND (${endEx}::timestamptz IS NULL OR p.last_viewed_at < ${endEx})) AS member_starts,
             (SELECT COUNT(*)::int FROM course_progress p
               WHERE p.module_id = m.id AND p.completed_at IS NOT NULL AND p.portal_user_id <> ALL(${skip})
                 AND (${start}::timestamptz IS NULL OR p.completed_at >= ${start})
                 AND (${endEx}::timestamptz IS NULL OR p.completed_at < ${endEx})) AS member_done,
             -- Capped at 100: furthest_seconds can exceed a stale duration after
             -- a video is re-uploaded, and a 140% watch rate reads as a bug.
             (SELECT ROUND(AVG(LEAST(100, 100.0 * p.furthest_seconds / NULLIF(p.duration_seconds, 0))))::int
                FROM course_progress p
               WHERE p.module_id = m.id AND COALESCE(p.duration_seconds, 0) > 0
                 AND p.portal_user_id <> ALL(${skip})) AS member_avg_pct
        FROM course_modules m
       WHERE m.published
       ORDER BY COALESCE(m.sort_order, m.module_number)
    `.catch(() => []),
    sql`
      SELECT TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
             COUNT(DISTINCT visitor_key)::int AS n
        FROM course_events
       WHERE event_key = 'page_view'
         AND (${start}::timestamptz IS NULL OR created_at >= ${start})
         AND (${endEx}::timestamptz IS NULL OR created_at < ${endEx})
       GROUP BY 1 ORDER BY 1
    `.catch(() => []),
  ]);

  const people = (k) => funnelRows.find((e) => e.event_key === k)?.people || 0;
  const raw = (k) => funnelRows.find((e) => e.event_key === k)?.n || 0;

  // Filtered by EMAIL rather than by portal user id: a signup row can exist
  // before an account does, so the id list alone would miss one.
  const [signupCount] = await sql`
    SELECT COUNT(*)::int AS n FROM course_signups
     WHERE (${start}::timestamptz IS NULL OR created_at >= ${start})
       AND (${endEx}::timestamptz IS NULL OR created_at < ${endEx})
       AND LOWER(email) <> ALL(${ourEmails})
       AND email NOT ILIKE '%@squideo.co.uk'
       AND email NOT ILIKE '%@squideo.com'
  `.catch(() => [{ n: 0 }]);

  return {
    funnel: {
      visitors: people('page_view'),
      pageViews: raw('page_view'),
      played: people('play'),
      reachedSignup: people('signup_open'),
      signedUp: signupCount?.n || 0,
    },
    videos: videoRows.map((v) => ({
      id: v.id,
      slug: v.slug,
      number: v.module_number,
      title: v.title,
      free: v.free === true,
      durationSeconds: v.duration_seconds ?? null,
      anon: {
        plays: v.anon_plays, q1: v.anon_25, q2: v.anon_50, q3: v.anon_75, done: v.anon_done,
      },
      member: {
        starts: v.member_starts, done: v.member_done, avgPct: v.member_avg_pct ?? null,
      },
    })),
    byDay: dayRows.map((r) => ({ day: String(r.day).slice(0, 10), n: r.n })),
  };
}

async function courseAnalytics(res, from = null, to = null) {
  // Our own accounts, resolved once and applied to every count below — see
  // api/_lib/internalAccounts.js. Testing the course means signing up to it and
  // watching it, and without this every test reads as a lead.
  const [skip, ourEmails] = await Promise.all([internalPortalUserIds(), internalEmails()]);
  const [signups, videos, events] = await Promise.all([
    sql`
      SELECT s.id, s.email, s.name, s.company_id, s.contact_id, s.completed_at,
             s.created_at, s.marketing_consent, s.attr_channel,
             c.name AS company_name,
             (SELECT COUNT(*)::int FROM course_progress p
                JOIN course_modules m ON m.id = p.module_id
               WHERE p.portal_user_id = s.portal_user_id
                 AND m.published AND p.completed_at IS NOT NULL) AS videos_done,
             (SELECT COUNT(DISTINCT DATE(p.last_viewed_at))::int FROM course_progress p
               WHERE p.portal_user_id = s.portal_user_id) AS active_days,
             (SELECT MAX(p.last_viewed_at) FROM course_progress p
               WHERE p.portal_user_id = s.portal_user_id) AS last_active_at,
             (SELECT COUNT(*)::int FROM quote_requests q
               WHERE LOWER(q.email) = LOWER(s.email)) AS quote_count,
             COALESCE((SELECT array_agg(p.module_id) FROM course_progress p
                        WHERE p.portal_user_id = s.portal_user_id
                          AND p.completed_at IS NOT NULL), '{}') AS done_module_ids
        FROM course_signups s
        LEFT JOIN companies c ON c.id = s.company_id
       WHERE LOWER(s.email) <> ALL(${ourEmails})
         AND s.email NOT ILIKE '%@squideo.co.uk'
         AND s.email NOT ILIKE '%@squideo.com'
       ORDER BY s.created_at DESC
       LIMIT 500
    `.catch(() => []),
    sql`
      SELECT m.id, m.slug, m.module_number, m.title, m.free,
             (SELECT COUNT(*)::int FROM course_progress p
               WHERE p.module_id = m.id AND p.portal_user_id <> ALL(${skip})) AS starts,
             (SELECT COUNT(*)::int FROM course_progress p
               WHERE p.module_id = m.id AND p.completed_at IS NOT NULL
                 AND p.portal_user_id <> ALL(${skip})) AS completions
        FROM course_modules m
       WHERE m.published
       ORDER BY COALESCE(m.sort_order, m.module_number)
    `.catch(() => []),
    sql`
      SELECT event_key, COUNT(*)::int AS n, COUNT(DISTINCT visitor_key)::int AS people
        FROM course_events
       WHERE created_at > NOW() - INTERVAL '90 days'
       GROUP BY event_key
    `.catch(() => []),
  ]);

  const eventCount = (k) => events.find((e) => e.event_key === k)?.people || 0;

  const rows = signups.map((s) => {
    const hot = hotScore(s);
    return {
      id: s.id,
      email: s.email,
      name: s.name || null,
      companyId: s.company_id || null,
      contactId: s.contact_id || null,
      companyName: s.company_name || null,
      channel: s.attr_channel || null,
      marketingConsent: s.marketing_consent === true,
      signedUpAt: s.created_at,
      lastActiveAt: s.last_active_at || null,
      videosDone: Number(s.videos_done || 0),
      doneModuleIds: Array.isArray(s.done_module_ids) ? s.done_module_ids.filter(Boolean) : [],
      completedAt: s.completed_at || null,
      enquiries: Number(s.quote_count || 0),
      ...hot,
    };
  });

  return res.status(200).json({
    funnel: {
      pageViews: eventCount('page_view'),
      plays: eventCount('play'),
      signupOpened: eventCount('signup_open'),
      signups: rows.length,
      started: rows.filter((r) => r.videosDone > 0).length,
      completed: rows.filter((r) => r.completedAt).length,
      enquiries: rows.filter((r) => r.enquiries > 0).length,
    },
    hot: rows.filter((r) => r.band === 'hot').length,
    warm: rows.filter((r) => r.band === 'warm').length,
    signups: rows,
    videos: videos.map((v) => ({
      id: v.id,
      slug: v.slug,
      moduleNumber: v.module_number,
      title: v.title,
      free: !!v.free,
      starts: Number(v.starts || 0),
      completions: Number(v.completions || 0),
    })),
    // The public side: everyone who landed, including the ones who never gave
    // us an email — invisible everywhere else in the CRM.
    reach: await courseReach(from, to, skip, ourEmails),
  });
}

async function deleteModule(res, existing) {
  await sql`DELETE FROM course_modules WHERE id = ${existing.id}`;
  if (existing.blob_url) {
    try { await del(existing.blob_url, { token: REVISION_BLOB_TOKEN }); }
    catch (err) { console.warn('[course] blob delete failed', err.message); }
  }
  return res.status(204).end();
}
