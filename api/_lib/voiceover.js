// Voiceover artist catalogue — shared by the staff admin CRUD (api/_lib/crm/
// voiceovers.js) and the customer portal (api/portal.js). The catalogue is
// GLOBAL: the same artists for every project, split into two sections
// (category 'ai' | 'human') matching squideo.com/squideo-voiceovers. One sample
// clip per artist lives in private Vercel Blob and is streamed back through the
// API (the store is private — its raw URL 403s; see [[project_blob_private]]).

import { put, del, get as blobGet } from '@vercel/blob';
import sql from './db.js';

export const VOICEOVER_CATEGORIES = ['ai', 'human'];
// Audio the browser's <audio> element can play, mapped to a content type.
export const VOICEOVER_MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
};
const BLOB_PREFIX = 'voiceover-samples';

// ── Self-heal (db/migrations/20260727_voiceover_catalogue.sql) ───────────────
// Module-cached; a successful first call short-circuits for the instance's
// lifetime. Never rejects into callers permanently — resets the cache on error
// so a later request retries, per [[feedback_selfheal_nonfatal]].
let catalogueEnsured = null;
export function ensureVoiceoverCatalogue() {
  if (catalogueEnsured) return catalogueEnsured;
  catalogueEnsured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS voiceover_artists (
        id            TEXT        PRIMARY KEY,
        category      TEXT        NOT NULL DEFAULT 'human',
        name          TEXT        NOT NULL,
        description   TEXT,
        blob_url      TEXT,
        blob_pathname TEXT,
        mime_type     TEXT,
        size_bytes    BIGINT,
        sort_order    INTEGER     NOT NULL DEFAULT 0,
        archived_at   TIMESTAMPTZ,
        created_by    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS voiceover_artists_list_idx
                ON voiceover_artists (category, sort_order, created_at)`;
    // Per-video selection columns. Mirrored in ensureProductionSchema() on the
    // CRM side; added here too so the portal (a separate function) self-heals
    // even if no CRM request has run on this instance. A non-null artist id =
    // locked. See [[feedback_selfheal_nonfatal]].
    await sql`ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS voiceover_artist_id TEXT`;
    await sql`ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS voiceover_selected_at TIMESTAMPTZ`;
    await sql`ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS voiceover_selected_by TEXT`;
  })().catch((err) => { catalogueEnsured = null; throw err; });
  return catalogueEnsured;
}

export function serialiseArtist(a) {
  return {
    id: a.id,
    category: a.category || 'human',
    name: a.name,
    description: a.description || null,
    hasSample: !!(a.blob_url || a.blob_pathname),
    mimeType: a.mime_type || null,
    sizeBytes: a.size_bytes == null ? null : Number(a.size_bytes),
    sortOrder: a.sort_order ?? 0,
    archivedAt: a.archived_at || null,
    createdAt: a.created_at,
  };
}

// One artist row by id, or null.
export async function getArtist(id) {
  if (!id) return null;
  const [row] = await sql`SELECT * FROM voiceover_artists WHERE id = ${id}`;
  return row || null;
}

// Store (or replace) an artist's sample clip in private Blob. Deletes the old
// blob first so we don't leak orphans. Returns the updated row.
export async function putArtistSample(artistId, buffer, { filename, ext }) {
  const mime = VOICEOVER_MIME[ext] || 'application/octet-stream';
  const existing = await getArtist(artistId);
  if (existing?.blob_url) {
    try { await del(existing.blob_url); } catch (err) { console.error('[voiceover] old sample delete failed', err.message); }
  }
  const safeName = String(filename || `sample.${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const blob = await put(`${BLOB_PREFIX}/${artistId}/${safeName}`, buffer, { access: 'private', contentType: mime });
  const [row] = await sql`
    UPDATE voiceover_artists
       SET blob_url = ${blob.url}, blob_pathname = ${blob.pathname},
           mime_type = ${mime}, size_bytes = ${buffer.length}, updated_at = NOW()
     WHERE id = ${artistId}
     RETURNING *`;
  return row;
}

// Stream an artist's sample back to the browser for an <audio> element. Honours
// a Range request so the scrubber can seek (the plain proxies elsewhere don't).
// Reads the whole (small) clip once, then slices — samples are a few seconds.
export async function streamVoiceoverSample(req, res, artist) {
  if (!artist || (!artist.blob_url && !artist.blob_pathname)) {
    return res.status(404).json({ error: 'No sample for this artist' });
  }
  const result = await blobGet(artist.blob_url || artist.blob_pathname, { access: 'private' });
  if (!result || !result.stream) return res.status(404).json({ error: 'Sample not found' });
  const full = Buffer.from(await new Response(result.stream).arrayBuffer());
  const type = artist.mime_type || 'audio/mpeg';
  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=300');

  const range = req.headers?.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m) {
    const total = full.length;
    let start = m[1] === '' ? null : parseInt(m[1], 10);
    let end = m[2] === '' ? null : parseInt(m[2], 10);
    if (start === null) { start = total - end; end = total - 1; }   // suffix range
    else if (end === null) { end = total - 1; }
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0 || end >= total) {
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }
    const chunk = full.subarray(start, end + 1);
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', String(chunk.length));
    return res.end(chunk);
  }
  res.setHeader('Content-Length', String(full.length));
  return res.status(200).end(full);
}
