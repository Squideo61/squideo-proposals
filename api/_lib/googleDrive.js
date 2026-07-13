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

// The standard production subfolder tree laid down inside every new deal/project
// folder, mirroring the "Template" layout. Order + numeric prefixes keep Drive
// sorting sensible (Drive sorts by name, so "1. ", "2. " stay in stage order).
const FOLDER_TEMPLATE = [
  { name: '1. Resources', children: [
    { name: 'Additional Assets' },
    { name: 'Branding' },
    { name: 'Documents' },
    { name: 'Reference Imagery' },
  ] },
  { name: '2. Pre-Production', children: [
    { name: '1. Script and Text Direction', children: [{ name: 'V1' }] },
    { name: '2. Storyboards', children: [{ name: 'V1' }] },
  ] },
  { name: '3. Video', children: [
    { name: 'V1', children: [
      { name: 'Audio' },
      { name: 'Video' },
      { name: 'Video Assets' },
    ] },
  ] },
  { name: '4. Signed Off' },
];

// Create a single subfolder under parentId, returning its id.
async function createSubfolder(accessToken, name, parentId) {
  const meta = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId],
  };
  const created = await driveFetch(
    accessToken,
    `${DRIVE_API}/files?supportsAllDrives=true&fields=id`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) },
  ).then((r) => r.json());
  return created.id;
}

// Apply the template tree under parentId, idempotently: existing subfolders
// (matched by name) are reused, only missing ones are created. Sequential so
// each child has its real parent id before its own children are created. Safe
// to re-run and safe on a folder that already holds files — exported so older
// deals can be backfilled with the template too.
export async function applyFolderTemplate(accessToken, parentId, nodes = FOLDER_TEMPLATE) {
  const query =
    `'${q(parentId)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const url =
    `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)` +
    `&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives&pageSize=1000`;
  const existing = await driveFetch(accessToken, url).then((r) => r.json());
  const byName = new Map((existing.files || []).map((f) => [f.name, f.id]));

  for (const node of nodes) {
    let id = byName.get(node.name);
    if (!id) id = await createSubfolder(accessToken, node.name, parentId);
    if (node.children && node.children.length) {
      await applyFolderTemplate(accessToken, id, node.children);
    }
  }
}

// Find a folder by exact name directly under parentId, creating it if missing.
// Idempotent: a re-run reuses the existing folder. Returns the folder id.
export async function ensureNamedSubfolder(accessToken, parentId, name) {
  const query =
    `'${q(parentId)}' in parents and mimeType='application/vnd.google-apps.folder' ` +
    `and name='${q(name)}' and trashed=false`;
  const url =
    `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)` +
    `&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives&pageSize=1`;
  const out = await driveFetch(accessToken, url).then((r) => r.json());
  const hit = (out.files || [])[0];
  if (hit) return hit.id;
  return createSubfolder(accessToken, name, parentId);
}

// Walk a named subfolder path under rootFolderId (e.g. ['2. Pre-Production',
// '1. Script and Text Direction']), returning the leaf folder's id, or null if
// any step is missing. Each hop lists the current folder's subfolders and
// matches by exact name.
export async function findSubfolderByPath(accessToken, rootFolderId, pathNames = []) {
  let current = rootFolderId;
  for (const name of pathNames) {
    const query =
      `'${q(current)}' in parents and mimeType='application/vnd.google-apps.folder' ` +
      `and name='${q(name)}' and trashed=false`;
    const url =
      `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives&pageSize=1`;
    const out = await driveFetch(accessToken, url).then((r) => r.json());
    const hit = (out.files || [])[0];
    if (!hit) return null;
    current = hit.id;
  }
  return current;
}

// Resolve (creating the template if needed) the folder at a named path under a
// deal's root folder. If the path is missing, lay down the standard template
// once and re-find; returns null only if it still can't be found.
export async function ensureSubfolderByPath(accessToken, rootFolderId, pathNames = []) {
  let id = await findSubfolderByPath(accessToken, rootFolderId, pathNames);
  if (id) return id;
  try { await applyFolderTemplate(accessToken, rootFolderId); } catch (_) { /* partial tree is fine */ }
  return findSubfolderByPath(accessToken, rootFolderId, pathNames);
}

// Find (by our dealId tag) or create the per-deal folder under the configured
// root. Returns { id, created }: the caller caches the id on the deal *before*
// scaffolding the template, so a concurrent caller sees the folder straight away
// rather than waiting out the (slow, many-call) scaffold and creating a second
// one. Callers must also serialise on the deal — Drive allows same-named
// siblings and its appProperties index lags writes, so two concurrent callers
// would both find nothing and both create a folder.
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
  if (found.files && found.files.length) return { id: found.files[0].id, created: false };

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
  return { id: created.id, created: true };
}

// Every folder under the root tagged with this dealId, oldest first. Normally
// one; more than one means duplicates were created (see dealDriveFolder), so the
// Files card can surface them for a manual merge.
export async function findDealFolders(accessToken, dealId) {
  const root = rootId();
  if (!root) return [];
  const query =
    `'${q(root)}' in parents and mimeType='application/vnd.google-apps.folder' ` +
    `and trashed=false and appProperties has { key='dealId' and value='${q(dealId)}' }`;
  const url =
    `${DRIVE_API}/files?q=${encodeURIComponent(query)}` +
    `&fields=files(id,name,createdTime,webViewLink)&orderBy=createdTime` +
    `&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`;
  const out = await driveFetch(accessToken, url).then((r) => r.json());
  return out.files || [];
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

// Start a resumable upload session so the browser can PUT the bytes straight to
// Drive (bypassing our serverless body limit for large files). Returns the
// session URI; the browser uploads to it directly, no token needed on the PUT.
export async function createResumableUploadSession(accessToken, { folderId, filename, mimeType, size }) {
  const meta = { name: filename, parents: [folderId] };
  const url = `${DRIVE_UPLOAD}?uploadType=resumable&supportsAllDrives=true&fields=id,webViewLink`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType || 'application/octet-stream',
      ...(size != null ? { 'X-Upload-Content-Length': String(size) } : {}),
    },
    body: JSON.stringify(meta),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Drive resumable init ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const location = res.headers.get('location');
  if (!location) throw new Error('Drive did not return a resumable session URL');
  return location;
}

// Fetch a Drive file's metadata (used to verify a browser-completed upload).
export async function getDriveFile(accessToken, fileId, fields = 'id,name,size,mimeType,parents,webViewLink') {
  return driveFetch(
    accessToken,
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`,
  ).then((r) => r.json());
}

// List the (non-trashed) files directly in a folder. Used to reconcile a deal's
// stored file list against what's actually in its Drive folder.
export async function listFolderFiles(accessToken, folderId) {
  const query = `'${q(folderId)}' in parents and trashed=false`;
  const url =
    `${DRIVE_API}/files?q=${encodeURIComponent(query)}` +
    `&fields=files(id,name,mimeType,size,webViewLink,createdTime)` +
    `&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives&pageSize=1000`;
  const out = await driveFetch(accessToken, url).then((r) => r.json());
  return out.files || [];
}

// List the subfolder tree under a folder (folders only, recursive), each with a
// Drive link so the UI can show the structure. Children at each level are fetched
// in parallel and depth-capped to keep it cheap; names come back sorted.
export async function listSubfolderTree(accessToken, folderId, depth = 0) {
  if (depth > 4) return [];
  const query =
    `'${q(folderId)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const url =
    `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name,webViewLink)` +
    `&orderBy=name&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives&pageSize=1000`;
  const out = await driveFetch(accessToken, url).then((r) => r.json());
  const folders = out.files || [];
  return Promise.all(folders.map(async (f) => ({
    id: f.id,
    name: f.name,
    webViewLink: f.webViewLink || null,
    children: await listSubfolderTree(accessToken, f.id, depth + 1),
  })));
}

// True if folderId is the same as, or a descendant of, rootId (walking up the
// parent chain). Bounded by maxHops so a cycle or very deep tree can't loop.
// Used to keep the folder browser scoped to a deal's own folder subtree.
export async function isFolderWithin(accessToken, folderId, rootId, maxHops = 10) {
  let current = folderId;
  for (let i = 0; i < maxHops && current; i++) {
    if (current === rootId) return true;
    const meta = await getDriveFile(accessToken, current, 'id,parents');
    current = meta?.parents?.[0] || null;
  }
  return false;
}

// List a folder's immediate children, split into subfolders and files (each with
// a Drive link). Backs the in-card folder browser.
export async function listFolderContents(accessToken, folderId) {
  const items = await listFolderFiles(accessToken, folderId);
  const folders = [];
  const files = [];
  for (const it of items) {
    if (it.mimeType === 'application/vnd.google-apps.folder') {
      folders.push({ id: it.id, name: it.name, webViewLink: it.webViewLink || null });
    } else {
      files.push({
        driveFileId: it.id,
        name: it.name,
        mimeType: it.mimeType || null,
        size: it.size != null ? Number(it.size) : null,
        webViewLink: it.webViewLink || null,
        createdTime: it.createdTime || null,
      });
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { folders, files };
}

// True if the folder still exists, isn't trashed, and is actually a folder.
// Returns false on 404 (deleted / inaccessible) so callers can recreate; other
// errors (auth/permission) re-throw so we don't recreate on a transient blip.
export async function folderUsable(accessToken, folderId) {
  try {
    const f = await getDriveFile(accessToken, folderId, 'id,trashed,mimeType');
    return !!f && f.trashed !== true && f.mimeType === 'application/vnd.google-apps.folder';
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
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
