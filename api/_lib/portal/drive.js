// Drive access for the portal library. Portal users have no Google OAuth of
// their own, so we borrow a connected STAFF account's token (any account whose
// stored scopes cover Drive) purely for reading each deal's "4. Signed Off"
// folder and streaming its files. The org check happens before any Drive call;
// clients never see raw Drive ids in a URL they could reuse elsewhere —
// download requests are re-validated against a fresh folder listing.

import sql from '../db.js';
import { getFreshAccessToken } from '../crm/gmail.js';
import { driveFilesEnabled, findSubfolderByPath, listFolderContents } from '../googleDrive.js';

const SIGNED_OFF_FOLDER = '4. Signed Off';

// A Drive-scoped access token from any connected staff account. Tries accounts
// newest-first and skips ones that fail to refresh. Returns null when Drive is
// unavailable (the library then renders its empty state).
let cachedToken = null;
let cachedUntil = 0;
export async function anyDriveAccessToken() {
  if (!driveFilesEnabled()) return null;
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;
  const rows = await sql`
    SELECT user_email FROM gmail_accounts
     WHERE disconnected_at IS NULL AND scopes LIKE '%auth/drive%'
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 5
  `;
  for (const r of rows) {
    try {
      const token = await getFreshAccessToken(r.user_email);
      cachedToken = token;
      cachedUntil = Date.now() + 60 * 1000; // access tokens live ~1h; re-check every minute
      return token;
    } catch (err) {
      console.warn('[portal drive] token via', r.user_email, 'failed:', err.message);
    }
  }
  return null;
}

// List the finished files in a deal's Signed Off folder. Returns [] when the
// deal has no Drive folder, the subfolder doesn't exist, or Drive is down —
// the library treats all of those as "still being prepared".
export async function listSignedOffFiles(accessToken, driveFolderId) {
  if (!accessToken || !driveFolderId) return [];
  try {
    const folderId = await findSubfolderByPath(accessToken, driveFolderId, [SIGNED_OFF_FOLDER]);
    if (!folderId) return [];
    const { files } = await listFolderContents(accessToken, folderId);
    return files.map((f) => ({
      driveFileId: f.driveFileId,
      name: f.name,
      mimeType: f.mimeType,
      sizeBytes: f.size,
      createdTime: f.createdTime,
    }));
  } catch (err) {
    console.warn('[portal drive] signed-off listing failed', err.message);
    return [];
  }
}

// Stream a Drive file's bytes to the response (alt=media), passing the
// client's Range header through so <video> scrubbing and resumed downloads
// work. The caller MUST have already validated org ownership + that the file
// id came from a fresh Signed Off listing for that deal.
export async function streamDriveFile(res, accessToken, driveFileId, { filename, mimeType, download = true } = {}) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFileId)}?alt=media&supportsAllDrives=true`;
  const headers = { Authorization: 'Bearer ' + accessToken };
  if (res.req?.headers?.range) headers.Range = res.req.headers.range;

  const driveRes = await fetch(url, { headers });
  if (!driveRes.ok && driveRes.status !== 206) {
    const body = await driveRes.text().catch(() => '');
    console.error('[portal drive] stream failed', driveRes.status, body.slice(0, 200));
    return res.status(502).json({ error: 'Could not fetch the file — try again shortly' });
  }

  res.status(driveRes.status === 206 ? 206 : 200);
  const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
  for (const h of passthrough) {
    const v = driveRes.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!driveRes.headers.get('content-type') && mimeType) res.setHeader('Content-Type', mimeType);
  if (download && filename) {
    const safe = String(filename).replace(/["\r\n]/g, '');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  }

  // Pipe the web stream into the Node response chunk by chunk.
  const reader = driveRes.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
  } catch (err) {
    console.warn('[portal drive] stream interrupted', err.message);
  } finally {
    res.end();
  }
}
