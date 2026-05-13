// Session lives in an HttpOnly cookie (sq_session) set by the server on
// successful login. The browser sends it automatically with same-origin
// requests, so we never read or attach a token here.
async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}

export const api = {
  get:    (path)        => request('GET',    path),
  post:   (path, body)  => request('POST',   path, body),
  put:    (path, body)  => request('PUT',    path, body),
  patch:  (path, body)  => request('PATCH',  path, body),
  delete: (path)        => request('DELETE', path),
};
