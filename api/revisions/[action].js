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

    if (action === 'versions') {
      if (req.method === 'POST') {
        const projectId = req.query.projectId ? String(req.query.projectId) : null;
        if (!projectId) return res.status(400).json({ error: 'projectId required' });
        return await registerVersion(req, res, user, projectId);
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
      rp.created_at, rp.updated_at,
      COALESCE(v.version_count, 0)::INT AS version_count,
      COALESCE(c.comment_count, 0)::INT AS comment_count
    FROM revision_projects rp
    LEFT JOIN (
      SELECT project_id, COUNT(*) AS version_count FROM revision_versions GROUP BY project_id
    ) v ON v.project_id = rp.id
    LEFT JOIN (
      SELECT rv.project_id, COUNT(*) AS comment_count
      FROM revision_comments rc JOIN revision_versions rv ON rv.id = rc.version_id
      GROUP BY rv.project_id
    ) c ON c.project_id = rp.id
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
  return res.status(201).json({ ...projectRow(row), versionCount: 0, commentCount: 0 });
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
    SELECT id, title, client_name, share_token, created_by, created_at, updated_at
    FROM revision_projects WHERE id = ${id}
  `;
  if (!project) return res.status(404).json({ error: 'not found' });

  const versions = await sql`
    SELECT id, version_number, label, filename, mime_type, size_bytes,
           blob_url, uploaded_by, created_at
    FROM revision_versions WHERE project_id = ${id}
    ORDER BY version_number DESC
  `;
  const comments = await sql`
    SELECT rc.id, rc.version_id, rc.parent_id, rc.timecode_seconds, rc.body,
           rc.author_name, rc.author_email, rc.created_at,
           rc.attachment_url, rc.attachment_name, rc.attachment_type
    FROM revision_comments rc
    JOIN revision_versions rv ON rv.id = rc.version_id
    WHERE rv.project_id = ${id}
    ORDER BY rc.created_at ASC
  `;
  return res.status(200).json({
    ...projectRow(project),
    versions: versions.map(versionRow),
    comments: comments.map(commentRow),
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

async function registerVersion(req, res, user, projectId) {
  const body = parseBody(req);
  const blobUrl = (body.blobUrl || '').trim();
  const blobPathname = body.blobPathname ? String(body.blobPathname) : null;
  const filename = (body.filename || 'video.mp4').trim();
  const mimeType = body.mimeType ? String(body.mimeType) : null;
  const sizeBytes = Number.isFinite(Number(body.sizeBytes)) ? Number(body.sizeBytes) : null;
  const label = body.label ? String(body.label).trim() : null;
  if (!blobUrl) return res.status(400).json({ error: 'blobUrl required' });

  const [project] = await sql`SELECT id FROM revision_projects WHERE id = ${projectId}`;
  if (!project) return res.status(404).json({ error: 'project not found' });

  const [{ next }] = await sql`
    SELECT COALESCE(MAX(version_number), 0) + 1 AS next
    FROM revision_versions WHERE project_id = ${projectId}
  `;
  const id = crypto.randomUUID();
  const [row] = await sql`
    INSERT INTO revision_versions
      (id, project_id, version_number, label, filename, mime_type, size_bytes,
       blob_url, blob_pathname, uploaded_by)
    VALUES
      (${id}, ${projectId}, ${next}, ${label || null}, ${filename},
       ${mimeType}, ${sizeBytes}, ${blobUrl}, ${blobPathname}, ${user.email || null})
    RETURNING id, version_number, label, filename, mime_type, size_bytes,
              blob_url, uploaded_by, created_at
  `;
  await sql`UPDATE revision_projects SET updated_at = NOW() WHERE id = ${projectId}`;
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

  const versions = await sql`
    SELECT id, version_number, label, mime_type, blob_url, created_at
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
  // Field allowlist: only what the viewer needs. No created_by, share_token, etc.
  return res.status(200).json({
    title: project.title,
    clientName: project.client_name,
    versions: versions.map(v => ({
      id: v.id,
      versionNumber: v.version_number,
      label: v.label,
      mimeType: v.mime_type,
      videoUrl: v.blob_url,
      createdAt: v.created_at,
    })),
    comments: comments.map(commentRow),
  });
}

async function postComment(req, res) {
  const token = req.query.token ? String(req.query.token) : null;
  if (!token) return res.status(400).json({ error: 'token required' });
  const body = parseBody(req);

  const versionId = (body.versionId || '').trim();
  const text = (body.body || '').trim();
  const authorName = (body.authorName || '').trim().slice(0, 120) || 'Guest';
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

  // The version must belong to the project this share_token unlocks.
  const [match] = await sql`
    SELECT rv.id FROM revision_versions rv
    JOIN revision_projects rp ON rp.id = rv.project_id
    WHERE rv.id = ${versionId} AND rp.share_token = ${token}
  `;
  if (!match) return res.status(404).json({ error: 'version not found' });

  // A reply's parent must be on the same version.
  let validParent = null;
  if (parentId) {
    const [p] = await sql`SELECT id FROM revision_comments WHERE id = ${parentId} AND version_id = ${versionId}`;
    if (p) validParent = parentId;
  }

  const id = crypto.randomUUID();
  const [row] = await sql`
    INSERT INTO revision_comments
      (id, version_id, parent_id, timecode_seconds, body, author_name,
       attachment_url, attachment_name, attachment_type)
    VALUES (${id}, ${versionId}, ${validParent}, ${timecode}, ${text}, ${authorName},
            ${attachmentUrl}, ${attachmentName}, ${attachmentType})
    RETURNING id, version_id, parent_id, timecode_seconds, body, author_name, created_at,
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
    versionCount: r.version_count !== undefined ? r.version_count : undefined,
    commentCount: r.comment_count !== undefined ? r.comment_count : undefined,
  };
}

function versionRow(r) {
  return {
    id: r.id,
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
