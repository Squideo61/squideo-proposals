// Field allowlists for the course API.
//
// The anonymous /course payload is the whole security boundary of this feature:
// the 8 videos are the thing being gated, and they live in a PUBLIC blob store,
// so a leaked URL is the entire course given away. The defence is structural
// rather than conditional — `publicModule()` has no code path that can emit a
// blob URL for ANY module, free or not. Playback goes through a separate
// endpoint that re-checks `free AND published` against the database.
//
// Do not add a `blobUrl` to publicModule(), even behind an `if`. The next
// person to touch a conditional gets it wrong; a serialiser that simply cannot
// express the unsafe output cannot be got wrong.

// Poster bytes are served by the API rather than inlined: posters are base64
// JPEGs and eight of them would bloat the landing payload by ~1MB.
//
// Two paths, because the two callers have opposite requirements. The public one
// serves PUBLISHED videos only. The admin one must serve DRAFTS too — picking a
// thumbnail is something you do before publishing, so a published-only endpoint
// would show the admin a broken image at exactly the moment they need to see
// the frame they just grabbed.
export const posterPath = (slug, version) =>
  `/api/course?action=poster&slug=${encodeURIComponent(slug)}` +
  (version ? `&v=${encodeURIComponent(version)}` : '');

// Behind CRM auth (settings.manage), so it can ignore `published`.
export const adminPosterPath = (id, version) =>
  `/api/crm/course/${encodeURIComponent(id)}/poster` +
  (version ? `?v=${encodeURIComponent(version)}` : '');

const posterVersion = (updatedAt) => {
  if (!updatedAt) return null;
  const t = new Date(updatedAt).getTime();
  return Number.isFinite(t) ? String(t) : null;
};

// What an anonymous visitor sees for every published module. `locked` drives
// the padlock chip on the grid — the module is still fully described (title,
// summary, duration, poster) because curiosity is what converts; only the
// bytes are withheld.
export function publicModule(row) {
  return {
    slug: row.slug,
    moduleNumber: row.module_number,
    title: row.title,
    subtitle: row.subtitle || null,
    description: row.description || null,
    durationSeconds: row.duration_seconds ?? null,
    posterUrl: row.poster ? posterPath(row.slug, posterVersion(row.poster_updated_at)) : null,
    free: !!row.free,
    locked: !row.free,
  };
}

// The staff-facing shape (Admin → Crash course). Carries the blob URL because
// the caller is an authenticated admin, and the upload/replace UI needs to know
// whether a file is actually attached.
export function adminModule(row) {
  return {
    id: row.id,
    slug: row.slug,
    moduleNumber: row.module_number,
    title: row.title,
    subtitle: row.subtitle || null,
    description: row.description || null,
    blobUrl: row.blob_url || null,
    blobPathname: row.blob_pathname || null,
    mimeType: row.mime_type || null,
    sizeBytes: row.size_bytes != null ? Number(row.size_bytes) : null,
    durationSeconds: row.duration_seconds ?? null,
    hasPoster: !!row.poster,
    posterUrl: row.poster ? adminPosterPath(row.id, posterVersion(row.poster_updated_at)) : null,
    free: !!row.free,
    published: !!row.published,
    sortOrder: row.sort_order ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Only ever called after the caller has been proven entitled to the bytes —
// either the module is free, or the request carries a live portal session.
export const playbackUrlFor = (slug) =>
  `/api/course?action=stream&slug=${encodeURIComponent(slug)}`;
