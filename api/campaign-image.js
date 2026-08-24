// Serves an image that a campaign email links to.
//
// PUBLIC and unauthenticated, necessarily: the thing fetching it is a stranger's
// mail client, which has no session and never will. That's also why the bytes
// can't simply be a blob URL — our store is private-only, so the read token
// lives on the server and a blob URL handed to a recipient returns "Forbidden"
// (see blobPrivate.js). The bytes are read here and relayed, exactly as the
// portal's client-logo endpoint does.
//
// What stops this being an open file host:
//   · ids are random and only ever handed out by the composer
//   · it will only serve rows in email_campaign_images, which only the campaign
//     image upload writes
//   · it will only ever answer with an image content type
//
// Cached hard. A campaign image is immutable — a new upload is a new id — and
// this endpoint may be hit once per recipient per open, so a long cache is the
// difference between one blob read and four thousand.

import sql from './_lib/db.js';
import { get as blobGet } from '@vercel/blob';

const IMAGE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml',
]);

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();

  const id = String(req.query?.i || '').trim();
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(id)) return res.status(400).end();

  let row;
  try {
    const rows = await sql`
      SELECT blob_url, mime_type, size_bytes FROM email_campaign_images WHERE id = ${id}`;
    row = rows[0];
  } catch (err) {
    console.error('[campaign-image] lookup failed', err.message);
    return res.status(500).end();
  }
  if (!row?.blob_url) return res.status(404).end();

  const type = IMAGE_TYPES.has(row.mime_type) ? row.mime_type : 'application/octet-stream';
  if (type === 'application/octet-stream') return res.status(415).end();

  try {
    const blob = await blobGet(row.blob_url, { access: 'private' });
    const body = blob?.body;
    if (!body) return res.status(404).end();

    res.setHeader('Content-Type', type);
    // Immutable: a replacement image is a different id.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (row.size_bytes) res.setHeader('Content-Length', String(row.size_bytes));
    // Mail clients and their image proxies fetch from anywhere.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'HEAD') return res.status(200).end();

    // Streamed rather than buffered — the same reason blobPrivate streams.
    const reader = body.getReader?.();
    if (!reader) {
      const buf = Buffer.from(await new Response(body).arrayBuffer());
      return res.status(200).end(buf);
    }
    res.status(200);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    return res.end();
  } catch (err) {
    console.error('[campaign-image] read failed', { id, err: err.message });
    return res.status(502).end();
  }
}
