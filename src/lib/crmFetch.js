// Same-origin calls to the staff CRM API, authorised by the staff session
// cookie. Lives here rather than in either bundle's api client because the
// shared InviteComposer is mounted by both the CRM and the client portal.
export async function crmApi(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || 'Request failed');
  return json;
}
