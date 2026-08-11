// Relay a blob's bytes through this origin, passing the client's Range header
// through so <video> scrubbing works.
//
// Normally a blob is served with a cheap 302 straight to the blob host. This
// exists for the one case the redirect can't cover: a canvas frame-capture
// (PosterPicker) taints on a cross-origin video, so the bytes have to arrive
// same-origin. Streaming rather than buffering matters here — these are video
// files, and reading a 150MB module into memory would blow the function.
//
// Callers: api/portal.js (library thumbnails) and api/_lib/crm/course.js
// (Admin → Video guide thumbnails).

export async function streamBlob(req, res, url, mimeType) {
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const upstream = await fetch(url, { headers }).catch(() => null);
  if (!upstream || (!upstream.ok && upstream.status !== 206)) {
    return res.status(502).json({ error: 'Could not fetch the file — try again shortly' });
  }
  res.status(upstream.status === 206 ? 206 : 200);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.headers.get('content-type') && mimeType) res.setHeader('Content-Type', mimeType);
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
  } catch (err) {
    // A client that seeks or navigates away aborts mid-stream constantly. It's
    // normal, not an error worth surfacing.
    console.warn('[blob] stream interrupted', err.message);
  } finally {
    res.end();
  }
}
