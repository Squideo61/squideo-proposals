/**
 * Sending an attachment with an enquiry — the public quote form and the
 * portal's "request a video", which share one endpoint and one blob store.
 *
 * Straight to Blob, not through our own function: the platform caps a request
 * body at ~4.5 MB and rejects it before any of our code runs, which is well
 * under the 20 MB these forms offer. A storyboard or a brief deck is routinely
 * bigger, so a client could attach one, watch it "upload", see the same
 * confirmation as everyone else — and we'd receive nothing, with no error on
 * either side. Everything else in the app (portal files, library, revisions,
 * storyboards, course) already uploads this way.
 *
 * The raw POST survives as a fallback, exactly as the portal's own upload keeps
 * one: if Blob can't be reached from the browser at all (a corporate proxy, an
 * ad-blocker with a wide net), a small file still gets through the old way. A
 * file too big for that path would only fail the same way twice, so it doesn't
 * try.
 */
const RAW_POST_LIMIT = 4 * 1024 * 1024;

export async function uploadEnquiryFile(file, apiBase = '/api/quote-requests') {
  const mimeType = file.type || 'application/octet-stream';
  try {
    const { upload } = await import('@vercel/blob/client');
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = await upload(`quote-requests/${Date.now()}-${safeName}`, file, {
      access: 'public',
      handleUploadUrl: `${apiBase}?action=upload-token`,
      contentType: mimeType,
      multipart: true, // splits the file into parts and retries a failed one
    });
    return {
      filename: file.name,
      mimeType,
      sizeBytes: file.size,
      blobUrl: blob.url,
      blobPathname: blob.pathname,
    };
  } catch (err) {
    if (file.size > RAW_POST_LIMIT) throw err;
    const res = await fetch(`${apiBase}?action=upload`, {
      method: 'POST',
      headers: { 'Content-Type': mimeType, 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json?.error || `Upload failed (${res.status})`);
    }
    const json = await res.json();
    return {
      filename: json.filename || file.name,
      mimeType: json.mimeType || mimeType,
      sizeBytes: json.sizeBytes || file.size,
      blobUrl: json.blobUrl,
      blobPathname: json.blobPathname,
    };
  }
}
