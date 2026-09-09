// Attachments a client tried to send with a lead and that never made it.
//
// The public forms upload straight to Blob now, but an upload can still fail —
// a dropped connection halfway through a 15 MB storyboard, storage briefly
// unreachable, a file the browser can't read back. Before this, that failure was
// silent on both sides: the client saw the same confirmation as everyone else,
// and we had a lead that gave no hint a brief had ever been attached. Someone
// had to notice the sentence "here's our storyboard" in an email weeks later.
//
// So the browser reports what it couldn't send, and we keep it next to the lead:
// on the team alert, in the quote-requests inbox, and on the deal it becomes.
// Asking a client to re-send one file is a small thing; not knowing to ask is
// not.
import sql from './db.js';

const MAX_ERRORS = 5;

// Shape: [{ filename, sizeBytes, reason }]. Sanitised hard — this is unvalidated
// input from a public form that we render into an email.
export function pickUploadErrors(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const item of v.slice(0, MAX_ERRORS)) {
    if (!item || typeof item !== 'object') continue;
    const filename = typeof item.filename === 'string'
      ? item.filename.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 255)
      : null;
    if (!filename) continue;
    const sizeBytes = Number.isFinite(item.sizeBytes) ? Math.floor(item.sizeBytes) : null;
    const reason = typeof item.reason === 'string'
      ? item.reason.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200)
      : null;
    out.push({ filename, sizeBytes, reason });
  }
  return out.length ? out : null;
}

// Self-heal for db/migrations/20260909_quote_request_upload_errors.sql.
//
// MUST NEVER REJECT — a rejected ensure() here would take out the public lead
// endpoint and the whole quote-requests inbox, which is how a self-heal meant to
// prevent an outage has caused one before. It resolves either way and clears the
// memo on failure so the next request tries again.
let ensured = null;
export function ensureUploadErrors() {
  if (ensured) return ensured;
  ensured = (async () => {
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS upload_errors JSONB`;
  })().catch((e) => {
    console.warn('[quote-requests] upload_errors ensure failed', e?.message);
    ensured = null;
  });
  return ensured;
}

// Postgres hands JSONB back parsed, but a driver that doesn't (or a legacy row
// written as text) shouldn't reach the UI as a string.
export function readUploadErrors(v) {
  if (!v) return null;
  if (Array.isArray(v)) return v.length ? v : null;
  if (typeof v === 'string') {
    try { return readUploadErrors(JSON.parse(v)); } catch { return null; }
  }
  return null;
}
