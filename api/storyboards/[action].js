// Single-file router for the storyboard-revisions / client-review feature.
// Parallel to api/revisions/[action].js, swapping the video player for a PDF
// slide renderer and timecode comments for per-slide + anchored (x/y pin)
// comments. The route name maps to req.query.action via the [action] dynamic
// segment.
//
// Producer (authenticated) routes:
//   GET    /api/storyboards/projects              — list projects + counts
//   POST   /api/storyboards/projects              — create a project (+ first storyboard)
//   DELETE /api/storyboards/projects?id=…         — delete a project (cascade + blobs)
//   GET    /api/storyboards/detail?id=…           — full project + storyboards + versions + comments
//   POST   /api/storyboards/storyboards?projectId=… — add a storyboard
//   DELETE /api/storyboards/storyboards?id=…      — delete a storyboard (+ blobs)
//   POST   /api/storyboards/upload-token          — Vercel Blob client-upload token handler
//   POST   /api/storyboards/versions?storyboardId=… — register a freshly-uploaded PDF
//   DELETE /api/storyboards/versions?id=…         — delete a version (+ blob)
//
// Public (no auth, keyed by share_token) routes:
//   GET    /api/storyboards/public?token=…        — project + storyboards + versions + comments
//   POST   /api/storyboards/comment?token=…       — leave a per-slide / anchored comment
//   POST   /api/storyboards/asset-token?token=…   — client-upload token for a comment asset
//   POST   /api/storyboards/approve?token=…       — client approves one storyboard
//   POST   /api/storyboards/viewer?token=…        — record a reviewer (name + email gate)
//   POST   /api/storyboards/view?token=…          — record a per-draft view
import crypto from 'crypto';
import { del } from '@vercel/blob';
import { handleUpload } from '@vercel/blob/client';
import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';
import { sendNotification, resolveDealTeamEmails } from '../_lib/notifications.js';
import { revisionFeedbackHtml, APP_URL } from '../_lib/email.js';

// Storyboard PDFs share the PUBLIC revision Blob store (so clients can fetch the
// bytes directly via the share link), reading REVISION_BLOB_READ_WRITE_TOKEN
// with the same fallback chain as the video revisions router.
const STORYBOARD_BLOB_TOKEN =
  process.env.REVISION_BLOB_READ_WRITE_TOKEN || process.env.REVIEW_BLOB_READ_WRITE_TOKEN;

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  return body || {};
}

// ─── Self-heal: create the storyboard_* tables if a workspace skipped the
// manual Neon apply of db/migrations/20260604_storyboard_revisions.sql. Same
// module-level cached pattern as ensureMessageDealsTable in _lib/crm/shared.js.
let tablesEnsured = null;
function ensureStoryboardTables() {
  if (tablesEnsured) return tablesEnsured;
  tablesEnsured = (async () => {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS storyboard_projects (
          id          TEXT        PRIMARY KEY,
          title       TEXT        NOT NULL,
          client_name TEXT,
          share_token TEXT        UNIQUE NOT NULL,
          created_by  TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          approved_at TIMESTAMPTZ,
          approved_by TEXT
        )`;
      await sql`
        CREATE TABLE IF NOT EXISTS storyboards (
          id          TEXT        PRIMARY KEY,
          project_id  TEXT        NOT NULL REFERENCES storyboard_projects(id) ON DELETE CASCADE,
          title       TEXT        NOT NULL,
          sort_order  INTEGER     NOT NULL DEFAULT 0,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          approved_at TIMESTAMPTZ,
          approved_by TEXT
        )`;
      await sql`CREATE INDEX IF NOT EXISTS storyboards_project_idx ON storyboards(project_id, sort_order, created_at)`;
      await sql`
        CREATE TABLE IF NOT EXISTS storyboard_versions (
          id             TEXT        PRIMARY KEY,
          project_id     TEXT        NOT NULL REFERENCES storyboard_projects(id) ON DELETE CASCADE,
          storyboard_id  TEXT        NOT NULL REFERENCES storyboards(id) ON DELETE CASCADE,
          version_number INTEGER     NOT NULL,
          label          TEXT,
          filename       TEXT        NOT NULL,
          mime_type      TEXT,
          size_bytes     BIGINT,
          page_count     INTEGER,
          blob_url       TEXT        NOT NULL,
          blob_pathname  TEXT,
          uploaded_by    TEXT,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`CREATE INDEX IF NOT EXISTS storyboard_versions_project_idx ON storyboard_versions(project_id, version_number DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS storyboard_versions_storyboard_idx ON storyboard_versions(storyboard_id, version_number DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS storyboard_comments (
          id               TEXT        PRIMARY KEY,
          version_id       TEXT        NOT NULL REFERENCES storyboard_versions(id) ON DELETE CASCADE,
          parent_id        TEXT        REFERENCES storyboard_comments(id) ON DELETE CASCADE,
          page_number      INTEGER     NOT NULL DEFAULT 1,
          anchor_x         NUMERIC(6,5),
          anchor_y         NUMERIC(6,5),
          body             TEXT        NOT NULL,
          author_name      TEXT        NOT NULL,
          author_email     TEXT,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          attachment_url   TEXT,
          attachment_name  TEXT,
          attachment_type  TEXT
        )`;
      await sql`CREATE INDEX IF NOT EXISTS storyboard_comments_version_idx ON storyboard_comments(version_id, page_number, created_at)`;
      await sql`
        CREATE TABLE IF NOT EXISTS storyboard_viewers (
          id          TEXT        PRIMARY KEY,
          project_id  TEXT        NOT NULL REFERENCES storyboard_projects(id) ON DELETE CASCADE,
          name        TEXT        NOT NULL,
          email       TEXT        NOT NULL,
          first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS storyboard_viewers_unique ON storyboard_viewers(project_id, lower(email))`;
      await sql`
        CREATE TABLE IF NOT EXISTS storyboard_version_views (
          id              TEXT        PRIMARY KEY,
          version_id      TEXT        NOT NULL REFERENCES storyboard_versions(id) ON DELETE CASCADE,
          project_id      TEXT        NOT NULL REFERENCES storyboard_projects(id) ON DELETE CASCADE,
          viewer_name     TEXT,
          viewer_email    TEXT        NOT NULL,
          view_count      INTEGER     NOT NULL DEFAULT 1,
          first_viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_viewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS storyboard_version_views_unique ON storyboard_version_views(version_id, lower(viewer_email))`;
      await sql`CREATE INDEX IF NOT EXISTS storyboard_version_views_project_idx ON storyboard_version_views(project_id)`;
      // 20260605_revision_feedback.sql columns (deal link + client feedback submit).
      await sql`ALTER TABLE storyboard_projects ADD COLUMN IF NOT EXISTS deal_id TEXT`;
      await sql`ALTER TABLE storyboards ADD COLUMN IF NOT EXISTS feedback_submitted_at TIMESTAMPTZ`;
      // 20260606_revision_completion_assignment.sql (per-draft completion + assignee).
      await sql`ALTER TABLE storyboard_versions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`;
      await sql`ALTER TABLE storyboard_versions ADD COLUMN IF NOT EXISTS completed_by TEXT`;
      await sql`ALTER TABLE storyboard_projects ADD COLUMN IF NOT EXISTS assignee_email TEXT`;
      // Presence "session start" — drives the live ConflictBanner.
      await sql`ALTER TABLE storyboard_viewers ADD COLUMN IF NOT EXISTS session_started_at TIMESTAMPTZ`;
      // 20260606_revision_comment_completion.sql (per-comment completion).
      await sql`ALTER TABLE storyboard_comments ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`;
      await sql`ALTER TABLE storyboard_comments ADD COLUMN IF NOT EXISTS completed_by TEXT`;
      // 20260606_revision_producer_notes.sql (internal producer note).
      await sql`ALTER TABLE storyboard_comments ADD COLUMN IF NOT EXISTS producer_note TEXT`;
    } catch (err) {
      tablesEnsured = null;
      console.warn('[storyboards] ensure tables failed', err.message);
    }
  })();
  return tablesEnsured;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = String(req.query.action || '');

  try {
    await ensureStoryboardTables();

    // ─── Public, unauthenticated routes (gated by share_token) ───────────────
    if (action === 'public') {
      if (req.method !== 'GET') return res.status(405).end();
      return await publicView(req, res);
    }
    if (action === 'comment') {
      if (req.method !== 'POST') return res.status(405).end();
      return await postComment(req, res);
    }
    if (action === 'asset-token') {
      if (req.method !== 'POST') return res.status(405).end();
      return await assetUploadToken(req, res);
    }
    if (action === 'approve') {
      if (req.method !== 'POST') return res.status(405).end();
      return await approveStoryboard(req, res);
    }
    // Client has finished reviewing a storyboard and submits their comments.
    if (action === 'submit-feedback') {
      if (req.method !== 'POST') return res.status(405).end();
      return await submitFeedback(req, res);
    }
    if (action === 'viewer') {
      if (req.method !== 'POST') return res.status(405).end();
      return await recordViewer(req, res);
    }
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

    // Assign the storyboard-revision project to a producer; logged to the deal.
    if (action === 'assign') {
      if (req.method !== 'POST') return res.status(405).end();
      const projectId = req.query.projectId ? String(req.query.projectId) : null;
      if (!projectId) return res.status(400).json({ error: 'projectId required' });
      return await assignProject(req, res, projectId, user);
    }

    // Producer marks a storyboard draft complete (or reopens it).
    if (action === 'complete-version') {
      if (req.method !== 'POST') return res.status(405).end();
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      return await completeVersion(req, res, id, user);
    }

    // Producer ticks an individual client comment (revision request) complete.
    if (action === 'complete-comment') {
      if (req.method !== 'POST') return res.status(405).end();
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      return await completeComment(req, res, id, user);
    }

    // Producer's internal note on a comment (team-only; summarised on completion).
    if (action === 'comment-note') {
      if (req.method !== 'POST') return res.status(405).end();
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      return await setCommentNote(req, res, id);
    }

    if (action === 'analytics') {
      if (req.method !== 'GET') return res.status(405).end();
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      return await projectAnalytics(res, id);
    }

    if (action === 'storyboards') {
      if (req.method === 'POST') {
        const projectId = req.query.projectId ? String(req.query.projectId) : null;
        if (!projectId) return res.status(400).json({ error: 'projectId required' });
        return await createStoryboard(req, res, projectId);
      }
      if (req.method === 'DELETE') {
        const id = req.query.id ? String(req.query.id) : null;
        if (!id) return res.status(400).json({ error: 'id required' });
        return await deleteStoryboard(res, id);
      }
      return res.status(405).end();
    }

    if (action === 'versions') {
      if (req.method === 'POST') {
        const storyboardId = req.query.storyboardId ? String(req.query.storyboardId) : null;
        if (!storyboardId) return res.status(400).json({ error: 'storyboardId required' });
        return await registerVersion(req, res, user, storyboardId);
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
    console.error('[storyboards]', err);
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
}

// ─── Producer: projects ───────────────────────────────────────────────────────

async function listProjects(res) {
  const rows = await sql`
    SELECT
      sp.id, sp.title, sp.client_name, sp.share_token, sp.created_by,
      sp.created_at, sp.updated_at, sp.approved_at, sp.deal_id, sp.assignee_email,
      d.title AS deal_title,
      COALESCE(sb.storyboard_count, 0)::INT AS storyboard_count,
      COALESCE(sb.approved_storyboard_count, 0)::INT AS approved_storyboard_count,
      COALESCE(sb.feedback_submitted_count, 0)::INT AS feedback_submitted_count,
      COALESCE(v.version_count, 0)::INT AS version_count,
      COALESCE(c.comment_count, 0)::INT AS comment_count,
      COALESCE(vc.viewer_count, 0)::INT AS viewer_count,
      COALESCE(vv.view_count, 0)::INT AS view_count
    FROM storyboard_projects sp
    LEFT JOIN deals d ON d.id = sp.deal_id
    LEFT JOIN (
      SELECT project_id, COUNT(*) AS storyboard_count, COUNT(approved_at) AS approved_storyboard_count,
             COUNT(feedback_submitted_at) AS feedback_submitted_count
      FROM storyboards GROUP BY project_id
    ) sb ON sb.project_id = sp.id
    LEFT JOIN (
      SELECT project_id, COUNT(*) AS version_count FROM storyboard_versions GROUP BY project_id
    ) v ON v.project_id = sp.id
    LEFT JOIN (
      SELECT sv.project_id, COUNT(*) AS comment_count
      FROM storyboard_comments sc JOIN storyboard_versions sv ON sv.id = sc.version_id
      GROUP BY sv.project_id
    ) c ON c.project_id = sp.id
    LEFT JOIN (
      SELECT project_id, COUNT(*) AS viewer_count FROM storyboard_viewers GROUP BY project_id
    ) vc ON vc.project_id = sp.id
    LEFT JOIN (
      SELECT project_id, COALESCE(SUM(view_count), 0) AS view_count FROM storyboard_version_views GROUP BY project_id
    ) vv ON vv.project_id = sp.id
    ORDER BY sp.updated_at DESC
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
    INSERT INTO storyboard_projects (id, title, client_name, share_token, created_by)
    VALUES (${id}, ${title}, ${clientName}, ${shareToken}, ${user.email || null})
    RETURNING id, title, client_name, share_token, created_by, created_at, updated_at
  `;
  // Every project starts with one storyboard so the common single-PDF case
  // needs no extra step; producers can add more.
  await sql`
    INSERT INTO storyboards (id, project_id, title, sort_order)
    VALUES (${crypto.randomUUID()}, ${id}, 'Storyboard 1', 0)
  `;
  return res.status(201).json({ ...projectRow(row), storyboardCount: 1, versionCount: 0, commentCount: 0 });
}

// ─── Producer: storyboards ──────────────────────────────────────────────────

async function createStoryboard(req, res, projectId) {
  const body = parseBody(req);
  const [project] = await sql`SELECT id FROM storyboard_projects WHERE id = ${projectId}`;
  if (!project) return res.status(404).json({ error: 'project not found' });
  const [{ next }] = await sql`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM storyboards WHERE project_id = ${projectId}
  `;
  const title = (body.title || '').trim() || ('Storyboard ' + (Number(next) + 1));
  const id = crypto.randomUUID();
  const [row] = await sql`
    INSERT INTO storyboards (id, project_id, title, sort_order)
    VALUES (${id}, ${projectId}, ${title}, ${next})
    RETURNING id, title, sort_order, created_at
  `;
  await sql`UPDATE storyboard_projects SET updated_at = NOW() WHERE id = ${projectId}`;
  return res.status(201).json({ id: row.id, title: row.title, sortOrder: row.sort_order, createdAt: row.created_at, versions: [] });
}

async function deleteStoryboard(res, id) {
  const versions = await sql`SELECT blob_url FROM storyboard_versions WHERE storyboard_id = ${id}`;
  for (const v of versions) {
    try { await del(v.blob_url, { token: STORYBOARD_BLOB_TOKEN }); } catch (err) {
      console.error('[storyboards] blob delete failed', err.message);
    }
  }
  const result = await sql`DELETE FROM storyboards WHERE id = ${id} RETURNING id`;
  if (!result.length) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ ok: true });
}

async function deleteProject(res, id) {
  const versions = await sql`SELECT blob_url FROM storyboard_versions WHERE project_id = ${id}`;
  for (const v of versions) {
    try { await del(v.blob_url, { token: STORYBOARD_BLOB_TOKEN }); } catch (err) {
      console.error('[storyboards] blob delete failed', err.message);
    }
  }
  const result = await sql`DELETE FROM storyboard_projects WHERE id = ${id} RETURNING id`;
  if (!result.length) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ ok: true });
}

async function projectDetail(res, id) {
  const [project] = await sql`
    SELECT sp.id, sp.title, sp.client_name, sp.share_token, sp.created_by, sp.created_at,
           sp.updated_at, sp.approved_at, sp.approved_by, sp.deal_id, sp.assignee_email, d.title AS deal_title
    FROM storyboard_projects sp
    LEFT JOIN deals d ON d.id = sp.deal_id
    WHERE sp.id = ${id}
  `;
  if (!project) return res.status(404).json({ error: 'not found' });

  const storyboards = await sql`
    SELECT id, title, sort_order, created_at, approved_at, approved_by, feedback_submitted_at FROM storyboards
    WHERE project_id = ${id} ORDER BY sort_order, created_at
  `;
  const versions = await sql`
    SELECT id, storyboard_id, version_number, label, filename, mime_type, size_bytes, page_count,
           blob_url, uploaded_by, created_at, completed_at, completed_by
    FROM storyboard_versions WHERE project_id = ${id}
    ORDER BY version_number DESC
  `;
  const views = await sql`
    SELECT version_id, viewer_name, viewer_email, view_count, first_viewed_at, last_viewed_at
    FROM storyboard_version_views WHERE project_id = ${id}
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
    SELECT sc.id, sc.version_id, sc.parent_id, sc.page_number, sc.anchor_x, sc.anchor_y, sc.body,
           sc.author_name, sc.author_email, sc.created_at,
           sc.attachment_url, sc.attachment_name, sc.attachment_type,
           sc.completed_at, sc.completed_by, sc.producer_note
    FROM storyboard_comments sc
    JOIN storyboard_versions sv ON sv.id = sc.version_id
    WHERE sv.project_id = ${id}
    ORDER BY sc.created_at ASC
  `;
  const viewers = await sql`
    SELECT name, email, first_seen, last_seen FROM storyboard_viewers
    WHERE project_id = ${id} ORDER BY last_seen DESC
  `;
  // Each storyboard may be linked back to a project_video card on a deal (via
  // project_videos.storyboard_id). The UI surfaces a "Linked to video card …"
  // / "Not linked to a video card" banner off this map.
  const links = storyboards.length
    ? await sql`
        SELECT pv.id AS pv_id, pv.title AS pv_title, pv.storyboard_id, pv.deal_id, d.title AS deal_title
          FROM project_videos pv
          LEFT JOIN deals d ON d.id = pv.deal_id
         WHERE pv.storyboard_id = ANY(${storyboards.map(s => s.id)})
      `
    : [];
  const linkByStoryboard = Object.fromEntries(links.map(l => [l.storyboard_id, {
    id: l.pv_id, title: l.pv_title, dealId: l.deal_id, dealTitle: l.deal_title,
  }]));
  return res.status(200).json({
    ...projectRow(project),
    storyboards: storyboards.map(sb => ({
      id: sb.id, title: sb.title, sortOrder: sb.sort_order, createdAt: sb.created_at,
      approvedAt: sb.approved_at || null, approvedBy: sb.approved_by || null,
      feedbackSubmittedAt: sb.feedback_submitted_at || null,
      linkedProjectVideo: linkByStoryboard[sb.id] || null,
      versions: versions.filter(v => v.storyboard_id === sb.id).map(ver => ({
        ...versionRow(ver), views: viewsByVersion[ver.id] || [],
      })),
    })),
    comments: comments.map(commentRow),
    viewers: viewers.map(vw => ({ name: vw.name, email: vw.email, firstSeen: vw.first_seen, lastSeen: vw.last_seen })),
  });
}

// ─── Producer: versions ──────────────────────────────────────────────────────

// Issues a short-lived client-upload token so the browser streams the PDF
// straight to Blob storage. The producer is authenticated here; the row is
// created afterwards by registerVersion once the upload resolves.
async function uploadToken(req, res) {
  if (!STORYBOARD_BLOB_TOKEN)
    return res.status(503).json({ error: 'Storyboard storage not configured (REVISION_BLOB_READ_WRITE_TOKEN missing)' });
  const body = parseBody(req);
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      token: STORYBOARD_BLOB_TOKEN,
      onBeforeGenerateToken: async () => {
        const user = await requireAuth(req, res);
        if (!user) throw new Error('Unauthorised');
        return { addRandomSuffix: true };
      },
    });
    return res.status(200).json(jsonResponse);
  } catch (err) {
    if (res.headersSent) return;
    return res.status(400).json({ error: err?.message || 'Upload authorisation failed' });
  }
}

// Mints a client-upload token for a comment attachment, authorised by the
// share_token rather than a login.
async function assetUploadToken(req, res) {
  if (!STORYBOARD_BLOB_TOKEN)
    return res.status(503).json({ error: 'Storyboard storage not configured' });
  const shareToken = req.query.token ? String(req.query.token) : null;
  const body = parseBody(req);
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      token: STORYBOARD_BLOB_TOKEN,
      onBeforeGenerateToken: async () => {
        if (!shareToken) throw new Error('token required');
        const [proj] = await sql`SELECT id FROM storyboard_projects WHERE share_token = ${shareToken}`;
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

async function registerVersion(req, res, user, storyboardId) {
  const body = parseBody(req);
  const blobUrl = (body.blobUrl || '').trim();
  const blobPathname = body.blobPathname ? String(body.blobPathname) : null;
  const filename = (body.filename || 'storyboard.pdf').trim();
  const mimeType = body.mimeType ? String(body.mimeType) : null;
  const sizeBytes = Number.isFinite(Number(body.sizeBytes)) ? Number(body.sizeBytes) : null;
  const pageCount = Number.isFinite(Number(body.pageCount)) ? Number(body.pageCount) : null;
  const label = body.label ? String(body.label).trim() : null;
  if (!blobUrl) return res.status(400).json({ error: 'blobUrl required' });

  const [storyboard] = await sql`SELECT id, project_id, title FROM storyboards WHERE id = ${storyboardId}`;
  if (!storyboard) return res.status(404).json({ error: 'storyboard not found' });

  // Draft numbers run per storyboard.
  const [{ next }] = await sql`
    SELECT COALESCE(MAX(version_number), 0) + 1 AS next
    FROM storyboard_versions WHERE storyboard_id = ${storyboardId}
  `;
  const id = crypto.randomUUID();
  const [row] = await sql`
    INSERT INTO storyboard_versions
      (id, project_id, storyboard_id, version_number, label, filename, mime_type, size_bytes,
       page_count, blob_url, blob_pathname, uploaded_by)
    VALUES
      (${id}, ${storyboard.project_id}, ${storyboardId}, ${next}, ${label || null}, ${filename},
       ${mimeType}, ${sizeBytes}, ${pageCount}, ${blobUrl}, ${blobPathname}, ${user.email || null})
    RETURNING id, storyboard_id, version_number, label, filename, mime_type, size_bytes, page_count,
              blob_url, uploaded_by, created_at
  `;
  // A new draft reopens that storyboard: clear its approval so the client can
  // review again and leave comments.
  await sql`UPDATE storyboards SET approved_at = NULL, approved_by = NULL WHERE id = ${storyboardId}`;
  await sql`UPDATE storyboard_projects SET updated_at = NOW() WHERE id = ${storyboard.project_id}`;
  // Surface on the deal timeline so the project page shows that a revised
  // storyboard PDF landed (mirrors revision_draft_uploaded).
  await logToDeal(
    storyboard.project_id,
    'storyboard_draft_uploaded',
    { storyboard: storyboard.title, draft: next, label: label || null },
    user.email,
  );
  return res.status(201).json(versionRow(row));
}

async function deleteVersion(res, id) {
  const [row] = await sql`SELECT blob_url FROM storyboard_versions WHERE id = ${id}`;
  if (!row) return res.status(404).json({ error: 'not found' });
  try { await del(row.blob_url, { token: STORYBOARD_BLOB_TOKEN }); } catch (err) {
    console.error('[storyboards] blob delete failed', err.message);
  }
  await sql`DELETE FROM storyboard_versions WHERE id = ${id}`;
  return res.status(200).json({ ok: true });
}

// Logs an event to the linked deal's activity (surfaces in the project / video
// section). No-op when the storyboard project isn't linked to a deal.
async function logToDeal(projectId, eventType, payload, actorEmail) {
  try {
    const [p] = await sql`SELECT deal_id FROM storyboard_projects WHERE id = ${projectId}`;
    if (!p?.deal_id) return;
    await sql`
      INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
      VALUES (${p.deal_id}, ${eventType}, ${JSON.stringify(payload || {})}, ${actorEmail || null})
    `;
  } catch (err) {
    console.error('[storyboards] activity log failed', err.message);
  }
}

async function assignProject(req, res, projectId, user) {
  const body = parseBody(req);
  const email = (body.assigneeEmail || '').trim().toLowerCase() || null;
  const [project] = await sql`SELECT id, title FROM storyboard_projects WHERE id = ${projectId}`;
  if (!project) return res.status(404).json({ error: 'not found' });
  await sql`UPDATE storyboard_projects SET assignee_email = ${email}, updated_at = NOW() WHERE id = ${projectId}`;
  if (email) {
    await logToDeal(projectId, 'storyboard_revision_assigned', { project: project.title, assignee: email }, user.email);
  }
  return res.status(200).json({ ok: true, assigneeEmail: email });
}

async function completeVersion(req, res, id, user) {
  const body = parseBody(req);
  const complete = body.complete !== false;
  const [ver] = await sql`
    SELECT sv.id, sv.project_id, sv.version_number, sb.title AS storyboard_title
      FROM storyboard_versions sv
      JOIN storyboards sb ON sb.id = sv.storyboard_id
     WHERE sv.id = ${id}
  `;
  if (!ver) return res.status(404).json({ error: 'not found' });
  const [row] = complete
    ? await sql`UPDATE storyboard_versions SET completed_at = NOW(), completed_by = ${user.email || null} WHERE id = ${id} RETURNING completed_at, completed_by`
    : await sql`UPDATE storyboard_versions SET completed_at = NULL, completed_by = NULL WHERE id = ${id} RETURNING completed_at, completed_by`;
  await sql`UPDATE storyboard_projects SET updated_at = NOW() WHERE id = ${ver.project_id}`;
  await logToDeal(
    ver.project_id,
    complete ? 'storyboard_revision_completed' : 'storyboard_revision_reopened',
    { storyboard: ver.storyboard_title, draft: ver.version_number, by: user.email },
    user.email,
  );
  return res.status(200).json({ id, completedAt: row.completed_at, completedBy: row.completed_by });
}

async function completeComment(req, res, id, user) {
  const body = parseBody(req);
  const complete = body.complete !== false;
  const [cur] = await sql`
    SELECT sc.id, sc.version_id, sv.version_number, sb.title AS storyboard_title
      FROM storyboard_comments sc
      JOIN storyboard_versions sv ON sv.id = sc.version_id
      JOIN storyboards sb ON sb.id = sv.storyboard_id
     WHERE sc.id = ${id}
  `;
  if (!cur) return res.status(404).json({ error: 'not found' });
  const [row] = complete
    ? await sql`UPDATE storyboard_comments SET completed_at = NOW(), completed_by = ${user.email || null} WHERE id = ${id} RETURNING completed_at, completed_by`
    : await sql`UPDATE storyboard_comments SET completed_at = NULL, completed_by = NULL WHERE id = ${id} RETURNING completed_at, completed_by`;

  if (complete) {
    const [{ total, open }] = await sql`
      SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE completed_at IS NULL)::int AS open
        FROM storyboard_comments WHERE version_id = ${cur.version_id}
    `;
    if (total > 0 && open === 0) {
      const title = cur.storyboard_title || 'Storyboard';
      const link = `${APP_URL}/#/storyboards`;
      const notes = await sql`
        SELECT producer_note FROM storyboard_comments
         WHERE version_id = ${cur.version_id} AND producer_note IS NOT NULL AND btrim(producer_note) <> ''
         ORDER BY created_at
      `;
      const noteList = notes.map(n => n.producer_note);
      const notesHtml = noteList.length
        ? `<p><strong>Producer notes:</strong></p><ul>${noteList.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
        : '';
      const notesText = noteList.length ? `\n\nProducer notes:\n${noteList.map(n => '• ' + n).join('\n')}` : '';
      try {
        await sendNotification('storyboard.draft_completed', {
          subject: `✅ Storyboard revisions complete: ${title} (draft ${cur.version_number})`,
          html: `<p>All client revisions on <strong>${escapeHtml(title)}</strong> — draft ${cur.version_number} have been marked complete.</p>${notesHtml}<p><a href="${link}">Open Storyboard Revisions</a></p>`,
          text: `All storyboard revisions on ${title} (draft ${cur.version_number}) are complete — ${link}${notesText}`,
          excludeEmails: user.email ? [user.email] : null,
          inApp: { title: `Storyboard revisions complete: ${title}`, body: `Every comment on draft ${cur.version_number} is done${noteList.length ? ` · ${noteList.length} producer note${noteList.length === 1 ? '' : 's'}` : ''}`, link: '#/storyboards' },
        });
      } catch (err) { console.error('[storyboards] draft-complete notify failed', err.message); }
    }
  }
  return res.status(200).json({ id, completedAt: row.completed_at, completedBy: row.completed_by });
}

// Set/clear the producer's internal note on a comment (team-only reference).
async function setCommentNote(req, res, id) {
  const body = parseBody(req);
  const note = (typeof body.note === 'string' ? body.note.trim() : '').slice(0, 2000) || null;
  const [row] = await sql`UPDATE storyboard_comments SET producer_note = ${note} WHERE id = ${id} RETURNING producer_note`;
  if (!row) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ id, producerNote: row.producer_note || null });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ─── Public: viewer + comments ───────────────────────────────────────────────

async function publicView(req, res) {
  const token = req.query.token ? String(req.query.token) : null;
  if (!token) return res.status(400).json({ error: 'token required' });
  // Polled on a heartbeat by StoryboardRevision, so this endpoint doubles as
  // presence: bump the viewer's last_seen and report who else is on the page.
  const viewerEmail = (req.query.viewerEmail || '').toString().trim().toLowerCase() || null;

  const [project] = await sql`
    SELECT id, title, client_name FROM storyboard_projects WHERE share_token = ${token}
  `;
  if (!project) return res.status(404).json({ error: 'Not found' });

  // Heartbeat (best-effort): only fires once the viewer has passed the gate.
  if (viewerEmail) {
    try {
      await sql`
        UPDATE storyboard_viewers
           SET last_seen = NOW(),
               session_started_at = CASE
                 WHEN last_seen IS NULL
                   OR last_seen < NOW() - INTERVAL '2 minutes'
                   OR session_started_at IS NULL
                 THEN NOW()
                 ELSE session_started_at
               END
         WHERE project_id = ${project.id} AND lower(email) = ${viewerEmail}
      `;
    } catch { /* presence is not load-bearing */ }
  }

  const [cfg] = await sql`SELECT revision_call_url FROM settings WHERE id = 1`;

  const storyboards = await sql`
    SELECT id, title, sort_order, created_at, approved_at, approved_by, feedback_submitted_at FROM storyboards
    WHERE project_id = ${project.id} ORDER BY sort_order, created_at
  `;
  const versions = await sql`
    SELECT id, storyboard_id, version_number, label, mime_type, page_count, blob_url, created_at
    FROM storyboard_versions WHERE project_id = ${project.id}
    ORDER BY version_number DESC
  `;
  const comments = await sql`
    SELECT sc.id, sc.version_id, sc.parent_id, sc.page_number, sc.anchor_x, sc.anchor_y, sc.body,
           sc.author_name, sc.created_at,
           sc.attachment_url, sc.attachment_name, sc.attachment_type
    FROM storyboard_comments sc
    JOIN storyboard_versions sv ON sv.id = sc.version_id
    WHERE sv.project_id = ${project.id}
    ORDER BY sc.created_at ASC
  `;
  const mapVersion = (v) => ({
    id: v.id, storyboardId: v.storyboard_id, versionNumber: v.version_number, label: v.label,
    mimeType: v.mime_type, pageCount: v.page_count != null ? Number(v.page_count) : null,
    pdfUrl: v.blob_url, createdAt: v.created_at,
  });
  // Active viewers (last 2 minutes) — drives the ConflictBanner. We never
  // return co-viewers' emails; names only plus a `you` flag computed against
  // the requester, and sessionStartedAt for arrival ordering.
  const viewers = await sql`
    SELECT name, lower(email) AS email, last_seen, session_started_at
      FROM storyboard_viewers
     WHERE project_id = ${project.id} AND last_seen > NOW() - INTERVAL '2 minutes'
     ORDER BY COALESCE(session_started_at, last_seen) ASC
  `;
  // Field allowlist: only what the viewer needs.
  return res.status(200).json({
    title: project.title,
    clientName: project.client_name,
    callUrl: (cfg && cfg.revision_call_url) || null,
    storyboards: storyboards.map(sb => ({
      id: sb.id, title: sb.title,
      approvedAt: sb.approved_at || null, approvedBy: sb.approved_by || null,
      feedbackSubmittedAt: sb.feedback_submitted_at || null,
      versions: versions.filter(v => v.storyboard_id === sb.id).map(mapVersion),
    })),
    comments: comments.map(commentRow),
    activeViewers: viewers.map(v => ({
      name: v.name,
      lastSeen: v.last_seen,
      sessionStartedAt: v.session_started_at,
      you: !!(viewerEmail && v.email === viewerEmail),
    })),
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
  const [proj] = await sql`SELECT id FROM storyboard_projects WHERE share_token = ${token}`;
  if (!proj) return res.status(404).json({ error: 'Not found' });
  await sql`
    INSERT INTO storyboard_viewers (id, project_id, name, email, session_started_at, last_seen)
    VALUES (${crypto.randomUUID()}, ${proj.id}, ${name}, ${email}, NOW(), NOW())
    ON CONFLICT (project_id, lower(email))
    DO UPDATE SET
      name = EXCLUDED.name,
      last_seen = NOW(),
      session_started_at = CASE
        WHEN storyboard_viewers.last_seen IS NULL
          OR storyboard_viewers.last_seen < NOW() - INTERVAL '2 minutes'
          OR storyboard_viewers.session_started_at IS NULL
        THEN NOW()
        ELSE storyboard_viewers.session_started_at
      END
  `;
  return res.status(200).json({ ok: true });
}

// Client finalises one storyboard: locks it so no further comments can be added
// to its drafts. Other storyboards in the project stay open.
async function approveStoryboard(req, res) {
  const token = req.query.token ? String(req.query.token) : null;
  if (!token) return res.status(400).json({ error: 'token required' });
  const body = parseBody(req);
  const storyboardId = (body.storyboardId || '').trim();
  const approvedBy = (body.approvedBy || '').trim().slice(0, 120) || 'Client';
  if (!storyboardId) return res.status(400).json({ error: 'storyboardId required' });

  const [storyboard] = await sql`
    SELECT sb.id, sb.approved_at, sb.project_id FROM storyboards sb
    JOIN storyboard_projects sp ON sp.id = sb.project_id
    WHERE sb.id = ${storyboardId} AND sp.share_token = ${token}
  `;
  if (!storyboard) return res.status(404).json({ error: 'Not found' });
  if (storyboard.approved_at) {
    return res.status(200).json({ storyboardId, approvedAt: storyboard.approved_at, alreadyApproved: true });
  }
  const [row] = await sql`
    UPDATE storyboards SET approved_at = NOW(), approved_by = ${approvedBy} WHERE id = ${storyboardId}
    RETURNING approved_at, approved_by
  `;
  await sql`UPDATE storyboard_projects SET updated_at = NOW() WHERE id = ${storyboard.project_id}`;
  return res.status(200).json({ storyboardId, approvedAt: row.approved_at, approvedBy: row.approved_by });
}

// Client submits their feedback for one storyboard: stamps feedback_submitted_at
// and fires ONE notification to the linked deal's team (never one-per-comment).
async function submitFeedback(req, res) {
  const token = req.query.token ? String(req.query.token) : null;
  if (!token) return res.status(400).json({ error: 'token required' });
  const body = parseBody(req);
  const storyboardId = (body.storyboardId || '').trim();
  const name = (body.name || '').trim().slice(0, 120) || 'The client';
  if (!storyboardId) return res.status(400).json({ error: 'storyboardId required' });

  const [sb] = await sql`
    SELECT s.id, s.title, s.project_id, sp.title AS project_title,
           sp.client_name, sp.deal_id, sp.created_by
      FROM storyboards s
      JOIN storyboard_projects sp ON sp.id = s.project_id
     WHERE s.id = ${storyboardId} AND sp.share_token = ${token}
  `;
  if (!sb) return res.status(404).json({ error: 'Not found' });

  const [row] = await sql`
    UPDATE storyboards SET feedback_submitted_at = NOW() WHERE id = ${storyboardId}
    RETURNING feedback_submitted_at
  `;
  await sql`UPDATE storyboard_projects SET updated_at = NOW() WHERE id = ${sb.project_id}`;

  const [{ n }] = await sql`
    SELECT COUNT(*)::int AS n FROM storyboard_comments sc
      JOIN storyboard_versions sv ON sv.id = sc.version_id
     WHERE sv.storyboard_id = ${storyboardId}
  `;

  try {
    const assigneeEmails = await resolveDealTeamEmails(sb.deal_id, sb.created_by);
    if (assigneeEmails.length) {
      const link = `${APP_URL}/#/storyboards`;
      const clientLabel = sb.client_name || name;
      const itemTitle = sb.title || sb.project_title;
      await sendNotification('storyboard.feedback_submitted', {
        assigneeEmails,
        subject: `${clientLabel} sent feedback on "${itemTitle}"`,
        html: revisionFeedbackHtml({ kind: 'storyboard', projectTitle: sb.project_title, itemTitle: sb.title, clientName: clientLabel, commentCount: n, link }),
        text: `${clientLabel} submitted ${n} comment${n === 1 ? '' : 's'} on ${itemTitle}. ${link}`,
        inApp: { title: `${clientLabel} sent storyboard feedback`, body: `${n} comment${n === 1 ? '' : 's'} on ${itemTitle}`, link: '#/storyboards' },
      });
    }
  } catch (err) {
    console.error('[storyboards] feedback notify failed', err.message);
  }

  return res.status(200).json({ storyboardId, feedbackSubmittedAt: row.feedback_submitted_at, commentCount: n });
}

// Producer links/unlinks a project to a CRM deal. Pass dealId=null to unlink.
async function linkDeal(req, res, projectId) {
  const body = parseBody(req);
  const dealId = body.dealId ? String(body.dealId) : null;
  const [row] = await sql`
    UPDATE storyboard_projects SET deal_id = ${dealId}, updated_at = NOW()
     WHERE id = ${projectId} RETURNING id, deal_id
  `;
  if (!row) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ id: row.id, dealId: row.deal_id || null });
}

// Engagement analytics for one project: per-viewer rollup + headline totals.
async function projectAnalytics(res, id) {
  const [project] = await sql`SELECT id, title, client_name FROM storyboard_projects WHERE id = ${id}`;
  if (!project) return res.status(404).json({ error: 'not found' });

  const views = await sql`
    SELECT lower(viewer_email) AS email, MAX(viewer_name) AS name,
           SUM(view_count)::int AS view_count, MAX(last_viewed_at) AS last_viewed_at
      FROM storyboard_version_views WHERE project_id = ${id} AND viewer_email IS NOT NULL
     GROUP BY lower(viewer_email)
  `;
  const commentsByEmail = await sql`
    SELECT lower(sc.author_email) AS email, COUNT(*)::int AS n
      FROM storyboard_comments sc JOIN storyboard_versions sv ON sv.id = sc.version_id
     WHERE sv.project_id = ${id} AND sc.author_email IS NOT NULL
     GROUP BY lower(sc.author_email)
  `;
  const cMap = new Map(commentsByEmail.map(r => [r.email, r.n]));
  const [{ total_comments }] = await sql`
    SELECT COUNT(*)::int AS total_comments FROM storyboard_comments sc
      JOIN storyboard_versions sv ON sv.id = sc.version_id WHERE sv.project_id = ${id}
  `;
  const [{ total_views }] = await sql`
    SELECT COALESCE(SUM(view_count),0)::int AS total_views FROM storyboard_version_views WHERE project_id = ${id}
  `;
  const [{ submitted, approved, sb_count }] = await sql`
    SELECT COUNT(feedback_submitted_at)::int AS submitted, COUNT(approved_at)::int AS approved,
           COUNT(*)::int AS sb_count
      FROM storyboards WHERE project_id = ${id}
  `;
  const viewers = views.map(v => ({
    email: v.email, name: v.name, viewCount: v.view_count,
    lastViewedAt: v.last_viewed_at, commentCount: cMap.get(v.email) || 0,
  })).sort((a, b) => new Date(b.lastViewedAt || 0) - new Date(a.lastViewedAt || 0));

  return res.status(200).json({
    id: project.id, title: project.title, clientName: project.client_name,
    totals: {
      views: total_views, uniqueViewers: viewers.length, comments: total_comments,
      videoCount: sb_count, feedbackSubmitted: submitted, approved,
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
    SELECT ver.id, ver.project_id FROM storyboard_versions ver
    JOIN storyboard_projects sp ON sp.id = ver.project_id
    WHERE ver.id = ${versionId} AND sp.share_token = ${token}
  `;
  if (!match) return res.status(404).json({ error: 'Not found' });
  await sql`
    INSERT INTO storyboard_version_views (id, version_id, project_id, viewer_name, viewer_email)
    VALUES (${crypto.randomUUID()}, ${versionId}, ${match.project_id}, ${name}, ${email})
    ON CONFLICT (version_id, lower(viewer_email))
    DO UPDATE SET view_count = storyboard_version_views.view_count + 1,
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
  const attachmentUrl = (typeof body.attachmentUrl === 'string' && body.attachmentUrl.startsWith('https://'))
    ? body.attachmentUrl.slice(0, 1000) : null;
  const attachmentName = attachmentUrl && body.attachmentName ? String(body.attachmentName).slice(0, 255) : null;
  const attachmentType = attachmentUrl && body.attachmentType ? String(body.attachmentType).slice(0, 120) : null;

  let pageNumber = 1;
  const pn = Number(body.pageNumber);
  if (Number.isFinite(pn) && pn >= 1) pageNumber = Math.round(pn);

  // Anchor is optional (whole-slide comment when absent). Both coords must be
  // present and within [0,1] to count as a pin.
  let anchorX = null, anchorY = null;
  const ax = Number(body.anchorX), ay = Number(body.anchorY);
  if (Number.isFinite(ax) && Number.isFinite(ay) && ax >= 0 && ax <= 1 && ay >= 0 && ay <= 1) {
    anchorX = Math.round(ax * 1e5) / 1e5;
    anchorY = Math.round(ay * 1e5) / 1e5;
  }

  if (!versionId) return res.status(400).json({ error: 'versionId required' });
  if (!text && !attachmentUrl) return res.status(400).json({ error: 'comment body or attachment required' });
  if (text.length > 4000) return res.status(400).json({ error: 'comment too long' });

  // The version must belong to the project this share_token unlocks, and its
  // storyboard must not yet be approved.
  const [match] = await sql`
    SELECT ver.id, sb.approved_at FROM storyboard_versions ver
    JOIN storyboards sb ON sb.id = ver.storyboard_id
    JOIN storyboard_projects sp ON sp.id = ver.project_id
    WHERE ver.id = ${versionId} AND sp.share_token = ${token}
  `;
  if (!match) return res.status(404).json({ error: 'version not found' });
  if (match.approved_at) {
    return res.status(403).json({ error: 'This storyboard has been approved and is now locked.' });
  }

  // A reply's parent must be on the same version.
  let validParent = null;
  if (parentId) {
    const [p] = await sql`SELECT id FROM storyboard_comments WHERE id = ${parentId} AND version_id = ${versionId}`;
    if (p) validParent = parentId;
  }

  const id = crypto.randomUUID();
  const [row] = await sql`
    INSERT INTO storyboard_comments
      (id, version_id, parent_id, page_number, anchor_x, anchor_y, body, author_name, author_email,
       attachment_url, attachment_name, attachment_type)
    VALUES (${id}, ${versionId}, ${validParent}, ${pageNumber}, ${anchorX}, ${anchorY}, ${text},
            ${authorName}, ${authorEmail}, ${attachmentUrl}, ${attachmentName}, ${attachmentType})
    RETURNING id, version_id, parent_id, page_number, anchor_x, anchor_y, body,
              author_name, author_email, created_at, attachment_url, attachment_name, attachment_type
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
    assigneeEmail: r.assignee_email !== undefined ? (r.assignee_email || null) : undefined,
    dealId: r.deal_id !== undefined ? (r.deal_id || null) : undefined,
    dealTitle: r.deal_title !== undefined ? (r.deal_title || null) : undefined,
    storyboardCount: r.storyboard_count !== undefined ? r.storyboard_count : undefined,
    approvedStoryboardCount: r.approved_storyboard_count !== undefined ? r.approved_storyboard_count : undefined,
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
    storyboardId: r.storyboard_id,
    versionNumber: r.version_number,
    label: r.label,
    filename: r.filename,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes != null ? Number(r.size_bytes) : null,
    pageCount: r.page_count != null ? Number(r.page_count) : null,
    pdfUrl: r.blob_url,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at,
    completedAt: r.completed_at || null,
    completedBy: r.completed_by || null,
  };
}

function commentRow(r) {
  return {
    id: r.id,
    versionId: r.version_id,
    parentId: r.parent_id,
    pageNumber: r.page_number != null ? Number(r.page_number) : 1,
    anchorX: r.anchor_x != null ? Number(r.anchor_x) : null,
    anchorY: r.anchor_y != null ? Number(r.anchor_y) : null,
    body: r.body,
    authorName: r.author_name,
    authorEmail: r.author_email,
    createdAt: r.created_at,
    attachmentUrl: r.attachment_url || null,
    attachmentName: r.attachment_name || null,
    attachmentType: r.attachment_type || null,
    completedAt: r.completed_at !== undefined ? (r.completed_at || null) : undefined,
    completedBy: r.completed_by !== undefined ? (r.completed_by || null) : undefined,
    producerNote: r.producer_note !== undefined ? (r.producer_note || null) : undefined,
  };
}
