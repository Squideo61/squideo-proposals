// Single-file router for the video-revisions / client-review feature. The
// route name maps to req.query.action via the [action] dynamic segment, the
// same pattern as api/partner/[action].js.
//
// Producer (authenticated) routes:
//   GET    /api/revisions/projects                — list projects + version counts
//   POST   /api/revisions/projects                — create a project
//   DELETE /api/revisions/projects?id=…           — delete a project (cascade + blobs)
//   GET    /api/revisions/detail?id=…             — full project + versions + comments
//   POST   /api/revisions/upload-token            — Vercel Blob client-upload token handler
//   POST   /api/revisions/versions?projectId=…    — register a freshly-uploaded version
//   DELETE /api/revisions/versions?id=…           — delete a version (+ blob)
//
// Public (no auth, keyed by share_token) routes:
//   GET    /api/revisions/public?token=…          — project + versions + comments for the viewer
//   POST   /api/revisions/comment?token=…         — leave a timecoded comment
import crypto from 'crypto';
import { del } from '@vercel/blob';
import { handleUpload } from '@vercel/blob/client';
import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';
import { sendNotification, resolveDealTeamEmails } from '../_lib/notifications.js';
import { revisionFeedbackHtml, APP_URL } from '../_lib/email.js';

// Self-heal for db/migrations/20260605_revision_feedback.sql. Idempotent +
// cached so we only run the ALTERs once per warm lambda.
let revisionFeedbackEnsured = null;
function ensureRevisionFeedbackColumns() {
  if (revisionFeedbackEnsured) return revisionFeedbackEnsured;
  revisionFeedbackEnsured = (async () => {
    await sql`ALTER TABLE revision_projects ADD COLUMN IF NOT EXISTS deal_id TEXT`;
    await sql`ALTER TABLE revision_videos ADD COLUMN IF NOT EXISTS feedback_submitted_at TIMESTAMPTZ`;
  })().catch((err) => { revisionFeedbackEnsured = null; throw err; });
  return revisionFeedbackEnsured;
}

// Revision videos live in their own PUBLIC Blob store (separate from the private
// store used for deal files) so clients can stream them directly via the share
// link. Reads REVISION_BLOB_READ_WRITE_TOKEN, falling back to the original
// REVIEW_BLOB_READ_WRITE_TOKEN so the working deployment keeps uploading until
// (optionally) the store is reconnected under the new prefix.
const REVISION_BLOB_TOKEN =
  process.env.REVISION_BLOB_READ_WRITE_TOKEN || process.env.REVIEW_BLOB_READ_WRITE_TOKEN;

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  return body || {};
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = String(req.query.action || '');

  try {
    await ensureRevisionFeedbackColumns();
    // ─── Public, unauthenticated routes (gated by share_token) ───────────────
    if (action === 'public') {
      if (req.method !== 'GET') return res.status(405).end();
      return await publicView(req, res);
    }
    if (action === 'comment') {
      if (req.method !== 'POST') return res.status(405).end();
      return await postComment(req, res);
    }
    // Public client-upload token for a comment's supporting asset. Authorised by
    // the share_token (the same unguessable link that unlocks the revision), so
    // unauthenticated reviewers can attach a file without a login.
    if (action === 'asset-token') {
      if (req.method !== 'POST') return res.status(405).end();
      return await assetUploadToken(req, res);
    }
    if (action === 'approve') {
      if (req.method !== 'POST') return res.status(405).end();
      return await approveRevision(req, res);
    }
    // Client has finished reviewing a video and submits their comments — fires
    // a single team notification (distinct from leaving individual comments).
    if (action === 'submit-feedback') {
      if (req.method !== 'POST') return res.status(405).end();
      return await submitFeedback(req, res);
    }
    // Name + email gate: records the viewer before they see the videos.
    if (action === 'viewer') {
      if (req.method !== 'POST') return res.status(405).end();
      return await recordViewer(req, res);
    }
    // Records that a viewer opened a specific draft.
    if (action === 'view') {
      if (req.method !== 'POST') return res.status(405).end();
      return await recordView(req, res);
    }

    // ─── Authenticated producer routes ───────────────────────────────────────
    // The Blob client-upload handshake authenticates inside onBeforeGenerateToken.
    if (action === 'upload-token') {
      if (req.method !== 'POST') return res.status(405).end();
      return await uploadToken(req, res);
    }

    const user = await requireAuth(req, res);
    if (!user) return;

    if (action === 'projects') {
      if (req.method === 'GET')    return await listProjects(res);
      if (req.method === 'POST')   return await createProject(req, res, user);
      if (req.method === 'DELETE') {
        const id = req.query.id ? String(req.query.id) : null;
        if (!id) return res.status(400).json({ error: 'id required' });
        return await deleteProject(res, id);
      }
      return res.status(405).end();
    }

    if (action === 'detail') {
      if (req.method !== 'GET') return res.status(405).end();
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      return await projectDetail(res, id);
    }

    if (action === 'link-deal') {
      if (req.method !== 'POST') return res.status(405).end();
      const projectId = req.query.projectId ? String(req.query.projectId) : null;
      if (!projectId) return res.status(400).json({ error: 'projectId required' });
      return await linkDeal(req, res, projectId);
    }

    if (action === 'analytics') {
      if (req.method !== 'GET') return res.status(405).end();
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      return await projectAnalytics(res, id);
    }

    if (action === 'videos') {
      if (req.method === 'POST') {
        const projectId = req.query.projectId ? String(req.query.projectId) : null;
        if (!projectId) return res.status(400).json({ error: 'projectId required' });
        return await createVideo(req, res, projectId);
      }
      if (req.method === 'DELETE') {
        const id = req.query.id ? String(req.query.id) : null;
        if (!id) return res.status(400).json({ error: 'id required' });
        return await deleteVideo(res, id);
      }
      return res.status(405).end();
    }

    if (action === 'versions') {
      if (req.method === 'POST') {
        const videoId = req.query.videoId ? String(req.query.videoId) : null;
        if (!videoId) return res.status(400).json({ error: 'videoId required' });
        return await registerVersion(req, res, user, videoId);
      }
      if (req.method === 'DELETE') {
        const id = req.query.id ? String(req.query.id) : null;
        if (!id) return res.status(400).json({ error: 'id required' });
        return await deleteVersion(res, id);
      }
      return res.status(405).end();
    }

    return res.status(404).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[revisions]', err);
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
}

// ─── Producer: projects ───────────────────────────────────────────────────────

async function listProjects(res) {
  const rows = await sql`
    SELECT
      rp.id, rp.title, rp.client_name, rp.share_token, rp.created_by,
      rp.created_at, rp.updated_at, rp.approved_at, rp.deal_id,
      d.title AS deal_title,
      COALESCE(vid.video_count, 0)::INT AS video_count,
      COALESCE(vid.approved_video_count, 0)::INT AS approved_video_count,
      COALESCE(vid.feedback_submitted_count, 0)::INT AS feedback_submitted_count,
      COALESCE(v.version_count, 0)::INT AS version_count,
      COALESCE(c.comment_count, 0)::INT AS comment_count,
      COALESCE(vc.viewer_count, 0)::INT AS viewer_count,
      COALESCE(vv.view_count, 0)::INT AS view_count
    FROM revision_projects rp
    LEFT JOIN deals d ON d.id = rp.deal_id
    LEFT JOIN (
      SELECT project_id, COUNT(*) AS video_count, COUNT(approved_at) AS approved_video_count,
             COUNT(feedback_submitted_at) AS feedback_submitted_count
      FROM revision_videos GROUP BY project_id
    ) vid ON vid.project_id = rp.id
    LEFT JOIN (
      SELECT project_id, COUNT(*) AS version_count FROM revision_versions GROUP BY project_id
    ) v ON v.project_id = rp.id
    LEFT JOIN (
      SELECT rv.project_id, COUNT(*) AS comment_count
      FROM revision_comments rc JOIN revision_versions rv ON rv.id = rc.version_id
      GROUP BY rv.project_id
    ) c ON c.project_id = rp.id
    LEFT JOIN (
      SELECT project_id, COUNT(*) AS viewer_count FROM revision_viewers GROUP BY project_id
    ) vc ON vc.project_id = rp.id
    LEFT JOIN (
      SELECT project_id, COALESCE(SUM(view_count), 0) AS view_count FROM revision_version_views GROUP BY project_id
    ) vv ON vv.project_id = rp.id
    ORDER BY rp.updated_at DESC
  `;
  return res.status(200).json(rows.map(projectRow));
}

async function createProject(req, res, user) {
  const body = parseBody(req);
  const title = (body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });
  const clientName = body.clientName ? String(body.clientName).trim() : null;

  const id = crypto.randomUUID();
  const shareToken = crypto.randomUUID();
  const [row] = await sql`
    INSERT INTO revision_projects (id, title, client_name, share_token, created_by)
    VALUES (${id}, ${title}, ${clientName}, ${shareToken}, ${user.email || null})
    RETURNING id, title, client_name, share_token, created_by, created_at, updated_at
  `;
  // Every project starts with one video so the common single-video case needs
  // no extra step; producers can add more.
  await sql`
    INSERT INTO revision_videos (id, project_id, title, sort_order)
    VALUES (${crypto.randomUUID()}, ${id}, 'Video 1', 0)
  `;
  return res.status(201).json({ ...projectRow(row), videoCount: 1, versionCount: 0, commentCount: 0 });
}

// ─── Producer: videos ──────────────────────────────────────────────────────

async function createVideo(req, res, projectId) {
  const body = parseBody(req);
  const [project] = await sql`SELECT id FROM revision_projects WHERE id = ${projectId}`;
  if (!project) return res.status(404).json({ error: 'project not found' });
  const [{ next }] = await sql`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM revision_videos WHERE project_id = ${projectId}
  `;
  const title = (body.title || '').trim() || ('Video ' + (Number(next) + 1));
  const id = crypto.randomUUID();
  const [row] = await sql`
    INSERT INTO revision_videos (id, project_id, title, sort_order)
    VALUES (${id}, ${projectId}, ${title}, ${next})
    RETURNING id, title, sort_order, created_at
  `;
  await sql`UPDATE revision_projects SET updated_at = NOW() WHERE id = ${projectId}`;
  return res.status(201).json({ id: row.id, title: row.title, sortOrder: row.sort_order, createdAt: row.created_at, versions: [] });
}

async function deleteVideo(res, id) {
  const versions = await sql`SELECT blob_url FROM revision_versions WHERE video_id = ${id}`;
  for (const v of versions) {
    try { await del(v.blob_url, { token: REVISION_BLOB_TOKEN }); } catch (err) {
      console.error('[revisions] blob delete failed', err.message);
    }
  }
  const result = await sql`DELETE FROM revision_videos WHERE id = ${id} RETURNING id`;
  if (!result.length) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ ok: true });
}

async function deleteProject(res, id) {
  // Remove the blobs first; the DB cascade then clears versions + comments.
  const versions = await sql`SELECT blob_url FROM revision_versions WHERE project_id = ${id}`;
  for (const v of versions) {
    try { await del(v.blob_url, { token: REVISION_BLOB_TOKEN }); } catch (err) {
      console.error('[revisions] blob delete failed', err.message);
    }
  }
  const result = await sql`DELETE FROM revision_projects WHERE id = ${id} RETURNING id`;
  if (!result.length) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ ok: true });
}

async function projectDetail(res, id) {
  const [project] = await sql`
    SELECT rp.id, rp.title, rp.client_name, rp.share_token, rp.created_by, rp.created_at,
           rp.updated_at, rp.approved_at, rp.approved_by, rp.deal_id, d.title AS deal_title
    FROM revision_projects rp
    LEFT JOIN deals d ON d.id = rp.deal_id
    WHERE rp.id = ${id}
  `;
  if (!project) return res.status(404).json({ error: 'not found' });

  const videos = await sql`
    SELECT id, title, sort_order, created_at, approved_at, approved_by, feedback_submitted_at FROM revision_videos
    WHERE project_id = ${id} ORDER BY sort_order, created_at
  `;
  const versions = await sql`
    SELECT id, video_id, version_number, label, filename, mime_type, size_bytes,
           blob_url, uploaded_by, created_at
    FROM revision_versions WHERE project_id = ${id}
    ORDER BY version_number DESC
  `;
  const views = await sql`
    SELECT version_id, viewer_name, viewer_email, view_count, first_viewed_at, last_viewed_at
    FROM revision_version_views WHERE project_id = ${id}
    ORDER BY last_viewed_at DESC
  `;
  const viewsByVersion = views.reduce((m, vw) => {
    (m[vw.version_id] = m[vw.version_id] || []).push({
      name: vw.viewer_name, email: vw.viewer_email, viewCount: vw.view_count,
      firstViewedAt: vw.first_viewed_at, lastViewedAt: vw.last_viewed_at,
    });
    return m;
  }, {});
  const comments = await sql`
    SELECT rc.id, rc.version_id, rc.parent_id, rc.timecode_seconds, rc.body,
           rc.author_name, rc.author_email, rc.created_at,
           rc.attachment_url, rc.attachment_name, rc.attachment_type
    FROM revision_comments rc
    JOIN revision_versions rv ON rv.id = rc.version_id
    WHERE rv.project_id = ${id}
    ORDER BY rc.created_at ASC
  `;
  const viewers = await sql`
    SELECT name, email, first_seen, last_seen FROM revision_viewers
    WHERE project_id = ${id} ORDER BY last_seen DESC
  `;
  return res.status(200).json({
    ...projectRow(project),
    videos: videos.map(vid => ({
      id: vid.id, title: vid.title, sortOrder: vid.sort_order, createdAt: vid.created_at,
      approvedAt: vid.approved_at || null, approvedBy: vid.approved_by || null,
      feedbackSubmittedAt: vid.feedback_submitted_at || null,
      versions: versions.filter(v => v.video_id === vid.id).map(ver => ({
        ...versionRow(ver), views: viewsByVersion[ver.id] || [],
      })),
    })),
    comments: comments.map(commentRow),
    viewers: viewers.map(vw => ({ name: vw.name, email: vw.email, firstSeen: vw.first_seen, lastSeen: vw.last_seen })),
  });
}

// ─── Producer: versions ──────────────────────────────────────────────────────

// Issues a short-lived client-upload token so the browser streams the video
// straight to Blob storage (bypassing the serverless body-size limit). The
// producer is authenticated here; the row is created afterwards by
// registerVersion once the upload resolves (works in local dev too, where the
// onUploadCompleted callback can't reach localhost).
async function uploadToken(req, res) {
  if (!REVISION_BLOB_TOKEN)
    return res.status(503).json({ error: 'Revision video storage not configured (REVISION_BLOB_READ_WRITE_TOKEN missing)' });
  const body = parseBody(req);
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      // Mint the client token against the public revision store, not the default
      // (private) deal-files store.
      token: REVISION_BLOB_TOKEN,
      onBeforeGenerateToken: async () => {
        const user = await requireAuth(req, res);
        if (!user) throw new Error('Unauthorised');
        // Keep the token minimal: a too-large maximumSizeInBytes or an
        // allowedContentTypes mismatch makes the multipart-create 400. Auth is
        // already enforced above, so producers can only reach this path.
        return { addRandomSuffix: true };
      },
      // NB: deliberately no onUploadCompleted. Providing it makes the Blob API
      // embed a callbackUrl and wait for a server-to-server confirmation before
      // the browser's upload() resolves — which never arrives on localhost (and
      // adds a fragile round-trip in prod), freezing the upload. The version row
      // is created instead by registerVersion right after upload() resolves.
    });
    return res.status(200).json(jsonResponse);
  } catch (err) {
    // requireAuth may already have sent a 401 for an unauthenticated caller.
    if (res.headersSent) return;
    return res.status(400).json({ error: err?.message || 'Upload authorisation failed' });
  }
}

// Mints a client-upload token for a comment attachment, authorised by the
// share_token rather than a login.
async function assetUploadToken(req, res) {
  if (!REVISION_BLOB_TOKEN)
    return res.status(503).json({ error: 'Revision storage not configured' });
  const shareToken = req.query.token ? String(req.query.token) : null;
  const body = parseBody(req);
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      token: REVISION_BLOB_TOKEN,
      onBeforeGenerateToken: async () => {
        if (!shareToken) throw new Error('token required');
        const [proj] = await sql`SELECT id FROM revision_projects WHERE share_token = ${shareToken}`;
        if (!proj) throw new Error('Invalid link');
        return { addRandomSuffix: true };
      },
    });
    return res.status(200).json(jsonResponse);
  } catch (err) {
    if (res.headersSent) return;
    return res.status(400).json({ error: err?.message || 'Upload authorisation failed' });
  }
}

async function registerVersion(req, res, user, videoId) {
  const body = parseBody(req);
  const blobUrl = (body.blobUrl || '').trim();
  const blobPathname = body.blobPathname ? String(body.blobPathname) : null;
  const filename = (body.filename || 'video.mp4').trim();
  const mimeType = body.mimeType ? String(body.mimeType) : null;
  const sizeBytes = Number.isFinite(Number(body.sizeBytes)) ? Number(body.sizeBytes) : null;
  const label = body.label ? String(body.label).trim() : null;
  if (!blobUrl) return res.status(400).json({ error: 'blobUrl required' });

  const [video] = await sql`SELECT id, project_id FROM revision_videos WHERE id = ${videoId}`;
  if (!video) return res.status(404).json({ error: 'video not found' });

  // Draft numbers run per video.
  const [{ next }] = await sql`
    SELECT COALESCE(MAX(version_number), 0) + 1 AS next
    FROM revision_versions WHERE video_id = ${videoId}
  `;
  const id = crypto.randomUUID();
  const [row] = await sql`
    INSERT INTO revision_versions
      (id, project_id, video_id, version_number, label, filename, mime_type, size_bytes,
       blob_url, blob_pathname, uploaded_by)
    VALUES
      (${id}, ${video.project_id}, ${videoId}, ${next}, ${label || null}, ${filename},
       ${mimeType}, ${sizeBytes}, ${blobUrl}, ${blobPathname}, ${user.email || null})
    RETURNING id, video_id, version_number, label, filename, mime_type, size_bytes,
              blob_url, uploaded_by, created_at
  `;
  // A new draft reopens that video: clear its approval so the client can review
  // again and leave comments.
  await sql`UPDATE revision_videos SET approved_at = NULL, approved_by = NULL WHERE id = ${videoId}`;
  await sql`UPDATE revision_projects SET updated_at = NOW() WHERE id = ${video.project_id}`;
  return res.status(201).json(versionRow(row));
}

async function deleteVersion(res, id) {
  const [row] = await sql`SELECT blob_url FROM revision_versions WHERE id = ${id}`;
  if (!row) return res.status(404).json({ error: 'not found' });
  try { await del(row.blob_url, { token: REVISION_BLOB_TOKEN }); } catch (err) {
    console.error('[revisions] blob delete failed', err.message);
  }
  await sql`DELETE FROM revision_versions WHERE id = ${id}`;
  return res.status(200).json({ ok: true });
}

// ─── Public: viewer + comments ───────────────────────────────────────────────

async function publicView(req, res) {
  const token = req.query.token ? String(req.query.token) : null;
  if (!token) return res.status(400).json({ error: 'token required' });

  const [project] = await sql`
    SELECT id, title, client_name FROM revision_projects WHERE share_token = ${token}
  `;
  if (!project) return res.status(404).json({ error: 'Not found' });

  const [cfg] = await sql`SELECT revision_call_url FROM settings WHERE id = 1`;

  const videos = await sql`
    SELECT id, title, sort_order, created_at, approved_at, approved_by, feedback_submitted_at FROM revision_videos
    WHERE project_id = ${project.id} ORDER BY sort_order, created_at
  `;
  const versions = await sql`
    SELECT id, video_id, version_number, label, mime_type, blob_url, created_at
    FROM revision_versions WHERE project_id = ${project.id}
    ORDER BY version_number DESC
  `;
  const comments = await sql`
    SELECT rc.id, rc.version_id, rc.parent_id, rc.timecode_seconds, rc.body,
           rc.author_name, rc.created_at,
           rc.attachment_url, rc.attachment_name, rc.attachment_type
    FROM revision_comments rc
    JOIN revision_versions rv ON rv.id = rc.version_id
    WHERE rv.project_id = ${project.id}
    ORDER BY rc.created_at ASC
  `;
  const mapVersion = (v) => ({
    id: v.id, videoId: v.video_id, versionNumber: v.version_number, label: v.label,
    mimeType: v.mime_type, videoUrl: v.blob_url, createdAt: v.created_at,
  });
  // Field allowlist: only what the viewer needs. No created_by, share_token, etc.
  return res.status(200).json({
    title: project.title,
    clientName: project.client_name,
    callUrl: (cfg && cfg.revision_call_url) || null,
    videos: videos.map(vid => ({
      id: vid.id, title: vid.title,
      approvedAt: vid.approved_at || null, approvedBy: vid.approved_by || null,
      feedbackSubmittedAt: vid.feedback_submitted_at || null,
      versions: versions.filter(v => v.video_id === vid.id).map(mapVersion),
    })),
    comments: comments.map(commentRow),
  });
}

// Records (upserts) a reviewer who passed the name + email gate.
async function recordViewer(req, res) {
  const token = req.query.token ? String(req.query.token) : null;
  if (!token) return res.status(400).json({ error: 'token required' });
  const body = parseBody(req);
  const name = (body.name || '').trim().slice(0, 120);
  const email = (body.email || '').trim().slice(0, 255).toLowerCase();
  if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid name and email are required' });
  }
  const [proj] = await sql`SELECT id FROM revision_projects WHERE share_token = ${token}`;
  if (!proj) return res.status(404).json({ error: 'Not found' });
  await sql`
    INSERT INTO revision_viewers (id, project_id, name, email)
    VALUES (${crypto.randomUUID()}, ${proj.id}, ${name}, ${email})
    ON CONFLICT (project_id, lower(email))
    DO UPDATE SET name = EXCLUDED.name, last_seen = NOW()
  `;
  return res.status(200).json({ ok: true });
}

// Client finalises one video: locks it so no further comments can be added to
// its drafts. Other videos in the project stay open.
async function approveRevision(req, res) {
  const token = req.query.token ? String(req.query.token) : null;
  if (!token) return res.status(400).json({ error: 'token required' });
  const body = parseBody(req);
  const videoId = (body.videoId || '').trim();
  const approvedBy = (body.approvedBy || '').trim().slice(0, 120) || 'Client';
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  // The video must belong to the project this share_token unlocks.
  const [video] = await sql`
    SELECT vid.id, vid.approved_at, vid.project_id FROM revision_videos vid
    JOIN revision_projects rp ON rp.id = vid.project_id
    WHERE vid.id = ${videoId} AND rp.share_token = ${token}
  `;
  if (!video) return res.status(404).json({ error: 'Not found' });
  if (video.approved_at) {
    return res.status(200).json({ videoId, approvedAt: video.approved_at, alreadyApproved: true });
  }
  const [row] = await sql`
    UPDATE revision_videos SET approved_at = NOW(), approved_by = ${approvedBy} WHERE id = ${videoId}
    RETURNING approved_at, approved_by
  `;
  await sql`UPDATE revision_projects SET updated_at = NOW() WHERE id = ${video.project_id}`;
  return res.status(200).json({ videoId, approvedAt: row.approved_at, approvedBy: row.approved_by });
}

// Client submits their feedback for one video: stamps feedback_submitted_at and
// fires ONE notification to the linked deal's team (never one-per-comment).
async function submitFeedback(req, res) {
  const token = req.query.token ? String(req.query.token) : null;
  if (!token) return res.status(400).json({ error: 'token required' });
  const body = parseBody(req);
  const videoId = (body.videoId || '').trim();
  const name = (body.name || '').trim().slice(0, 120) || 'The client';
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  const [video] = await sql`
    SELECT vid.id, vid.title, vid.project_id, rp.title AS project_title,
           rp.client_name, rp.deal_id, rp.created_by
      FROM revision_videos vid
      JOIN revision_projects rp ON rp.id = vid.project_id
     WHERE vid.id = ${videoId} AND rp.share_token = ${token}
  `;
  if (!video) return res.status(404).json({ error: 'Not found' });

  const [row] = await sql`
    UPDATE revision_videos SET feedback_submitted_at = NOW() WHERE id = ${videoId}
    RETURNING feedback_submitted_at
  `;
  await sql`UPDATE revision_projects SET updated_at = NOW() WHERE id = ${video.project_id}`;

  const [{ n }] = await sql`
    SELECT COUNT(*)::int AS n FROM revision_comments rc
      JOIN revision_versions rv ON rv.id = rc.version_id
     WHERE rv.video_id = ${videoId}
  `;

  // Best-effort: a notification failure must not break the client's submission.
  try {
    const assigneeEmails = await resolveDealTeamEmails(video.deal_id, video.created_by);
    if (assigneeEmails.length) {
      const link = `${APP_URL}/#/revisions`;
      const clientLabel = video.client_name || name;
      const itemTitle = video.title || video.project_title;
      await sendNotification('revision.feedback_submitted', {
        assigneeEmails,
        subject: `${clientLabel} sent feedback on "${itemTitle}"`,
        html: revisionFeedbackHtml({ kind: 'video', projectTitle: video.project_title, itemTitle: video.title, clientName: clientLabel, commentCount: n, link }),
        text: `${clientLabel} submitted ${n} comment${n === 1 ? '' : 's'} on ${itemTitle}. ${link}`,
        inApp: { title: `${clientLabel} sent video feedback`, body: `${n} comment${n === 1 ? '' : 's'} on ${itemTitle}`, link: '#/revisions' },
      });
    }
  } catch (err) {
    console.error('[revisions] feedback notify failed', err.message);
  }

  return res.status(200).json({ videoId, feedbackSubmittedAt: row.feedback_submitted_at, commentCount: n });
}

// Producer links/unlinks a project to a CRM deal (deal team gets the feedback
// notifications). Pass dealId=null to unlink.
async function linkDeal(req, res, projectId) {
  const body = parseBody(req);
  const dealId = body.dealId ? String(body.dealId) : null;
  const [row] = await sql`
    UPDATE revision_projects SET deal_id = ${dealId}, updated_at = NOW()
     WHERE id = ${projectId} RETURNING id, deal_id
  `;
  if (!row) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ id: row.id, dealId: row.deal_id || null });
}

// Engagement analytics for one project: per-viewer rollup (views + comments)
// plus headline totals. Mirrors the proposal Viewing-analytics modal.
async function projectAnalytics(res, id) {
  const [project] = await sql`SELECT id, title, client_name FROM revision_projects WHERE id = ${id}`;
  if (!project) return res.status(404).json({ error: 'not found' });

  // Per-viewer: total views across drafts (by email) + comments authored.
  const views = await sql`
    SELECT lower(viewer_email) AS email, MAX(viewer_name) AS name,
           SUM(view_count)::int AS view_count, MAX(last_viewed_at) AS last_viewed_at
      FROM revision_version_views WHERE project_id = ${id} AND viewer_email IS NOT NULL
     GROUP BY lower(viewer_email)
  `;
  const commentsByEmail = await sql`
    SELECT lower(rc.author_email) AS email, COUNT(*)::int AS n
      FROM revision_comments rc JOIN revision_versions rv ON rv.id = rc.version_id
     WHERE rv.project_id = ${id} AND rc.author_email IS NOT NULL
     GROUP BY lower(rc.author_email)
  `;
  const cMap = new Map(commentsByEmail.map(r => [r.email, r.n]));
  const [{ total_comments }] = await sql`
    SELECT COUNT(*)::int AS total_comments FROM revision_comments rc
      JOIN revision_versions rv ON rv.id = rc.version_id WHERE rv.project_id = ${id}
  `;
  const [{ total_views }] = await sql`
    SELECT COALESCE(SUM(view_count),0)::int AS total_views FROM revision_version_views WHERE project_id = ${id}
  `;
  const [{ submitted, approved, video_count }] = await sql`
    SELECT COUNT(feedback_submitted_at)::int AS submitted, COUNT(approved_at)::int AS approved,
           COUNT(*)::int AS video_count
      FROM revision_videos WHERE project_id = ${id}
  `;
  const viewers = views.map(v => ({
    email: v.email, name: v.name, viewCount: v.view_count,
    lastViewedAt: v.last_viewed_at, commentCount: cMap.get(v.email) || 0,
  })).sort((a, b) => new Date(b.lastViewedAt || 0) - new Date(a.lastViewedAt || 0));

  return res.status(200).json({
    id: project.id, title: project.title, clientName: project.client_name,
    totals: {
      views: total_views, uniqueViewers: viewers.length, comments: total_comments,
      videoCount: video_count, feedbackSubmitted: submitted, approved,
    },
    viewers,
  });
}

// Upserts a per-draft view record for a reviewer.
async function recordView(req, res) {
  const token = req.query.token ? String(req.query.token) : null;
  if (!token) return res.status(400).json({ error: 'token required' });
  const body = parseBody(req);
  const versionId = (body.versionId || '').trim();
  const name = (body.name || '').trim().slice(0, 120) || null;
  const email = (body.email || '').trim().slice(0, 255).toLowerCase();
  if (!versionId || !email) return res.status(400).json({ error: 'versionId and email required' });

  const [match] = await sql`
    SELECT ver.id, ver.project_id FROM revision_versions ver
    JOIN revision_projects rp ON rp.id = ver.project_id
    WHERE ver.id = ${versionId} AND rp.share_token = ${token}
  `;
  if (!match) return res.status(404).json({ error: 'Not found' });
  await sql`
    INSERT INTO revision_version_views (id, version_id, project_id, viewer_name, viewer_email)
    VALUES (${crypto.randomUUID()}, ${versionId}, ${match.project_id}, ${name}, ${email})
    ON CONFLICT (version_id, lower(viewer_email))
    DO UPDATE SET view_count = revision_version_views.view_count + 1,
                  viewer_name = EXCLUDED.viewer_name,
                  last_viewed_at = NOW()
  `;
  return res.status(200).json({ ok: true });
}

async function postComment(req, res) {
  const token = req.query.token ? String(req.query.token) : null;
  if (!token) return res.status(400).json({ error: 'token required' });
  const body = parseBody(req);

  const versionId = (body.versionId || '').trim();
  const text = (body.body || '').trim();
  const authorName = (body.authorName || '').trim().slice(0, 120) || 'Guest';
  const authorEmail = (body.authorEmail || '').trim().slice(0, 255) || null;
  const parentId = body.parentId ? String(body.parentId) : null;
  // Optional supporting asset (already uploaded to our public revision store).
  const attachmentUrl = (typeof body.attachmentUrl === 'string' && body.attachmentUrl.startsWith('https://'))
    ? body.attachmentUrl.slice(0, 1000) : null;
  const attachmentName = attachmentUrl && body.attachmentName ? String(body.attachmentName).slice(0, 255) : null;
  const attachmentType = attachmentUrl && body.attachmentType ? String(body.attachmentType).slice(0, 120) : null;
  let timecode = null;
  if (body.timecodeSeconds !== null && body.timecodeSeconds !== undefined && body.timecodeSeconds !== '') {
    const t = Number(body.timecodeSeconds);
    if (Number.isFinite(t) && t >= 0) timecode = Math.round(t * 100) / 100;
  }
  if (!versionId) return res.status(400).json({ error: 'versionId required' });
  if (!text && !attachmentUrl) return res.status(400).json({ error: 'comment body or attachment required' });
  if (text.length > 4000) return res.status(400).json({ error: 'comment too long' });

  // The version must belong to the project this share_token unlocks, and its
  // video must not yet be approved.
  const [match] = await sql`
    SELECT ver.id, vid.approved_at FROM revision_versions ver
    JOIN revision_videos vid ON vid.id = ver.video_id
    JOIN revision_projects rp ON rp.id = ver.project_id
    WHERE ver.id = ${versionId} AND rp.share_token = ${token}
  `;
  if (!match) return res.status(404).json({ error: 'version not found' });
  if (match.approved_at) {
    return res.status(403).json({ error: 'This video has been approved and is now locked.' });
  }

  // A reply's parent must be on the same version.
  let validParent = null;
  if (parentId) {
    const [p] = await sql`SELECT id FROM revision_comments WHERE id = ${parentId} AND version_id = ${versionId}`;
    if (p) validParent = parentId;
  }

  const id = crypto.randomUUID();
  const [row] = await sql`
    INSERT INTO revision_comments
      (id, version_id, parent_id, timecode_seconds, body, author_name, author_email,
       attachment_url, attachment_name, attachment_type)
    VALUES (${id}, ${versionId}, ${validParent}, ${timecode}, ${text}, ${authorName}, ${authorEmail},
            ${attachmentUrl}, ${attachmentName}, ${attachmentType})
    RETURNING id, version_id, parent_id, timecode_seconds, body, author_name, author_email, created_at,
              attachment_url, attachment_name, attachment_type
  `;
  return res.status(201).json(commentRow(row));
}

// ─── Row mappers ─────────────────────────────────────────────────────────────

function projectRow(r) {
  return {
    id: r.id,
    title: r.title,
    clientName: r.client_name,
    shareToken: r.share_token,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    approvedAt: r.approved_at || null,
    approvedBy: r.approved_by || null,
    dealId: r.deal_id !== undefined ? (r.deal_id || null) : undefined,
    dealTitle: r.deal_title !== undefined ? (r.deal_title || null) : undefined,
    videoCount: r.video_count !== undefined ? r.video_count : undefined,
    approvedVideoCount: r.approved_video_count !== undefined ? r.approved_video_count : undefined,
    feedbackSubmittedCount: r.feedback_submitted_count !== undefined ? r.feedback_submitted_count : undefined,
    versionCount: r.version_count !== undefined ? r.version_count : undefined,
    commentCount: r.comment_count !== undefined ? r.comment_count : undefined,
    viewerCount: r.viewer_count !== undefined ? r.viewer_count : undefined,
    viewCount: r.view_count !== undefined ? r.view_count : undefined,
  };
}

function versionRow(r) {
  return {
    id: r.id,
    videoId: r.video_id,
    versionNumber: r.version_number,
    label: r.label,
    filename: r.filename,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes != null ? Number(r.size_bytes) : null,
    videoUrl: r.blob_url,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at,
  };
}

function commentRow(r) {
  return {
    id: r.id,
    versionId: r.version_id,
    parentId: r.parent_id,
    timecodeSeconds: r.timecode_seconds != null ? Number(r.timecode_seconds) : null,
    body: r.body,
    authorName: r.author_name,
    authorEmail: r.author_email,
    createdAt: r.created_at,
    attachmentUrl: r.attachment_url || null,
    attachmentName: r.attachment_name || null,
    attachmentType: r.attachment_type || null,
  };
}
