// Serving a file out of the PRIVATE blob store.
//
// Our store is private-only, so a blob URL is not something a browser can ever
// fetch: the read token lives on the server and never travels with the request.
// Handing one out (including getDownloadUrl's `?download=1` variant of it, which
// only decorates the URL — it does not sign it) gets the user a bare "Forbidden"
// page. The bytes have to be read here and relayed.
//
// Streamed rather than buffered: these are client documents and PO PDFs today,
// but the same helper is the right home for anything larger later, and reading a
// big file wholly into memory is how a function runs out of it.
import { get as blobGet } from '@vercel/blob';

// A download endpoint answers twice over. Asked plainly it returns JSON with a
// `downloadUrl` — which is now itself, plus `?bytes=1`; asked with that param it
// streams the file. The browser can't send our session cookie to the blob host,
// but it can to us, so the same route, the same session and the same permission
// check cover both halves and there's no second gate to keep in step.
export const BYTES_PARAM = 'bytes';

// Read from req.query where the platform populated it, falling back to the URL
// itself — the CRM's routes arrive via a vercel.json rewrite, and the router
// there already parses its own params out of req.url for the same reason.
export function wantsBytes(req) {
  const direct = req?.query?.[BYTES_PARAM];
  if (direct != null) return String(direct) === '1';
  const qs = String(req?.url || '').split('?')[1] || '';
  return new URLSearchParams(qs).get(BYTES_PARAM) === '1';
}

export function bytesUrl(path) {
  return `${path}${path.includes('?') ? '&' : '?'}${BYTES_PARAM}=1`;
}

// Content-Disposition that survives a non-ASCII filename: a stripped-back
// `filename` for old clients, plus RFC 5987 `filename*` for everyone else.
function dispositionHeader(filename, download) {
  const type = download ? 'attachment' : 'inline';
  if (!filename) return type;
  const ascii = String(filename).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// Relay a private blob to the client. `source` is a blob URL or a pathname.
// Returns after the response is finished; callers should `return` it.
export async function streamPrivateBlob(res, source, {
  filename = null,
  mimeType = null,
  download = true,
  cacheControl = 'private, max-age=300',
} = {}) {
  if (!source) return res.status(404).json({ error: 'File not found' });

  let result = null;
  try {
    result = await blobGet(source, { access: 'private' });
  } catch (err) {
    console.error('[blob] private read failed', err?.message);
  }
  // A blob that's been deleted (or a row pointing at one that never landed)
  // reads as missing rather than as a server error — there's nothing to retry.
  if (!result || !result.stream) return res.status(404).json({ error: 'File not found' });

  res.status(200);
  res.setHeader('Content-Type', mimeType || result.blob?.contentType || 'application/octet-stream');
  if (result.blob?.size != null) res.setHeader('Content-Length', String(result.blob.size));
  res.setHeader('Content-Disposition', dispositionHeader(filename, download));
  res.setHeader('Cache-Control', cacheControl);
  // Served from our own origin, so don't let a mislabelled upload be sniffed
  // into something executable.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const reader = result.stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
  } catch (err) {
    // Navigating away mid-download aborts the stream. Normal, not an error.
    console.warn('[blob] private stream interrupted', err.message);
  } finally {
    res.end();
  }
}
