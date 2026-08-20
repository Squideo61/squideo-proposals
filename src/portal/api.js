// Thin fetch wrapper for the portal API. The session lives in the HttpOnly
// sq_portal cookie set by the server — never read or attached in JS. Same
// error contract as src/api.js: { error } → thrown Error(message).
//
// Staff "preview as client" is the one exception to the cookie rule: its token
// lives in sessionStorage (per-tab, so it never collides with a real client's
// cookie in the same browser) and rides along as an X-Portal-Preview header.

import { isDemoMode, demoRequest } from './demo/portalDemo.js';

const PREVIEW_KEY = 'squideo:portal:preview';

export function setPreviewToken(token) {
  try {
    if (token) sessionStorage.setItem(PREVIEW_KEY, token);
    else sessionStorage.removeItem(PREVIEW_KEY);
  } catch { /* ignore */ }
}

export function getPreviewToken() {
  try { return sessionStorage.getItem(PREVIEW_KEY) || null; } catch { return null; }
}

export function isPreview() {
  return !!getPreviewToken();
}

function withPreview(headers = {}) {
  const t = getPreviewToken();
  return t ? { ...headers, 'X-Portal-Preview': t } : headers;
}

// For URLs the BROWSER loads directly — <video>/<audio> sources, download links,
// the Blob upload-token endpoint. Those requests are made by the platform, not
// by our fetch wrapper, so they can't carry the preview header; a staff session
// passes the same signed token as ?pv= instead. A real client session rides on
// its HttpOnly cookie and gets the URL back unchanged.
export function mediaUrl(path) {
  const t = getPreviewToken();
  if (!t) return `/api/portal/${path}`;
  return `/api/portal/${path}${path.includes('?') ? '&' : '?'}pv=${encodeURIComponent(t)}`;
}

async function request(method, path, body) {
  // The admin portal demo. Answered from fixtures rather than the network,
  // so every real page renders against invented data with no special cases
  // and nothing can reach the database — see ./demo/portalDemo.js.
  if (isDemoMode()) return demoRequest(method, path, body);
  const base = body !== undefined ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(`/api/portal/${path}`, {
    method,
    headers: withPreview(base),
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error(json?.error || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return json;
}

// Staff CRM calls from manage mode go through crmApi in src/lib/crmFetch.js —
// it's shared with the CRM bundle, which mounts the same InviteComposer.

export const portalApi = {
  get:    (path)       => request('GET', path),
  post:   (path, body) => request('POST', path, body ?? {}),
  patch:  (path, body) => request('PATCH', path, body ?? {}),
  delete: (path)       => request('DELETE', path),

  // File upload, browser-direct to Blob storage and then registered.
  //
  // It used to POST the bytes to our own function, which the platform caps at
  // ~4.5MB — under the 20MB this accepts, and rejected before any of our code
  // ran, so an oversized file produced a bare "Upload failed" with nothing to
  // act on. A brand-guidelines PDF is routinely bigger than that. Everything
  // else in the app (library, revisions, storyboards, course) already uploads
  // this way; this was the one route left doing it the old way.
  //
  // The raw POST survives as a fallback: if Blob storage can't be reached from
  // the browser, a small file still gets through exactly as it used to.
  async upload(path, file) {
    try {
      const { upload: blobUpload } = await import('@vercel/blob/client');
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const blob = await blobUpload(`portal-files/${Date.now()}-${safeName}`, file, {
        access: 'private',
        // The platform makes this request, not our fetch wrapper, so it can't
        // carry the preview header — mediaUrl passes the same signed token as
        // ?pv= instead. See its note above.
        handleUploadUrl: mediaUrl('files-upload-token'),
        contentType: file.type || 'application/octet-stream',
        multipart: true,
      });
      return await request('POST', path, {
        blobUrl: blob.url,
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
      });
    } catch (err) {
      // A rejection from OUR registration step is a real answer ("that file
      // type isn't supported") — surface it rather than retrying the whole
      // thing down a path that will fail the same way.
      if (err?.status) throw err;
      return rawUpload(path, file);
    }
  },
};

async function rawUpload(path, file) {
  const res = await fetch(`/api/portal/${path}`, {
    method: 'POST',
    headers: withPreview({
      'Content-Type': file.type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name),
    }),
    credentials: 'include',
    body: file,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    // A non-JSON body here is the platform refusing the request before it
    // reached us — which, at this size, is only ever the body limit.
    throw new Error(json?.error
      || (file.size > 4 * 1024 * 1024
        ? 'That file is too large to upload from here. Email it to your producer and we’ll add it for you.'
        : 'Upload failed'));
  }
  return json;
}
