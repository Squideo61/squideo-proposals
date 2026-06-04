// Minimal Google Drive helper for deal files — create/find a per-deal folder in
// a shared Team Drive, upload, link and delete, using a user's OAuth access
// token (obtained via getFreshAccessToken). All calls pass supportsAllDrives so
// they work against Shared Drives, not just My Drive.
//
// Enabled only when DEAL_DRIVE_ROOT_ID is set (the Shared Drive id, or a folder
// id within it, that per-deal folders live under).

import { driveFilesEnabled } from './crm/shared.js';

export { driveFilesEnabled };

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

function rootId() {
  return process.env.DEAL_DRIVE_ROOT_ID || null;
}

async function driveFetch(accessToken, url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: 'Bearer ' + accessToken, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Drive API ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// Drive query string escaping: single quotes must be backslash-escaped.
function q(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Find (by our dealId tag) or create the per-deal folder under the configured
// root. Returns the folder id.
export async function ensureDealFolder(accessToken, { dealId, name }) {
  const root = rootId();
  if (!root) throw new Error('DEAL_DRIVE_ROOT_ID not configured');

  const query =
    `'${q(root)}' in parents and mimeType='application/vnd.google-apps.folder' ` +
    `and trashed=false and appProperties has { key='dealId' and value='${q(dealId)}' }`;
  const listUrl =
    `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)` +
    `&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`;
  const found = await driveFetch(accessToken, listUrl).then((r) => r.json());
  if (found.files && found.files.length) return found.files[0].id;

  const meta = {
    name: (name || dealId).slice(0, 120),
    mimeType: 'application/vnd.google-apps.folder',
    parents: [root],
    appProperties: { dealId: String(dealId) },
  };
  const created = await driveFetch(
    accessToken,
    `${DRIVE_API}/files?supportsAllDrives=true&fields=id`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) },
  ).then((r) => r.json());
  return created.id;
}

// Multipart upload of a buffer into a folder. Returns { id, webViewLink }.
export async function uploadToFolder(accessToken, { folderId, filename, mimeType, buffer }) {
  const boundary = 'sq_' + Math.random().toString(36).slice(2);
  const meta = { name: filename, parents: [folderId] };
  const pre =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`;
  const post = `\r\n--${boundary}--`;
  const body = Buffer.concat([Buffer.from(pre, 'utf8'), buffer, Buffer.from(post, 'utf8')]);

  const url = `${DRIVE_UPLOAD}?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink`;
  const out = await driveFetch(accessToken, url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  }).then((r) => r.json());
  return { id: out.id, webViewLink: out.webViewLink || null };
}

export async function getDriveFileLink(accessToken, fileId) {
  const out = await driveFetch(
    accessToken,
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=webViewLink&supportsAllDrives=true`,
  ).then((r) => r.json());
  return out.webViewLink || null;
}

export async function deleteDriveFile(accessToken, fileId) {
  await driveFetch(
    accessToken,
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
    { method: 'DELETE' },
  );
}
