// Thin fetch wrapper for the portal API. The session lives in the HttpOnly
// sq_portal cookie set by the server — never read or attached in JS. Same
// error contract as src/api.js: { error } → thrown Error(message).
//
// Staff "preview as client" is the one exception to the cookie rule: its token
// lives in sessionStorage (per-tab, so it never collides with a real client's
// cookie in the same browser) and rides along as an X-Portal-Preview header.

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

async function request(method, path, body) {
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

export const portalApi = {
  get:    (path)       => request('GET', path),
  post:   (path, body) => request('POST', path, body ?? {}),
  patch:  (path, body) => request('PATCH', path, body ?? {}),
  delete: (path)       => request('DELETE', path),

  // Raw-body file upload (X-Filename header, same as the CRM deal-files route).
  async upload(path, file) {
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
    if (!res.ok) throw new Error(json?.error || 'Upload failed');
    return json;
  },
};
