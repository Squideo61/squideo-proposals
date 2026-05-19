// Shared helpers used across the per-resource CRM handlers.
import sql from '../db.js';

// Self-heal for db/migrations/20260519_email_message_deals.sql — the
// message-level email/deal join table. Called by every file that reads or
// writes the table (threads.js for the link endpoints, deals.js for the
// detail-view read query) so workspaces that skipped the manual Neon apply
// still work. Module-level cached: a successful first call short-circuits
// subsequent ones for the lifetime of the Vercel instance.
let messageDealsTableEnsured = null;
export async function ensureMessageDealsTable() {
  if (messageDealsTableEnsured) return messageDealsTableEnsured;
  messageDealsTableEnsured = (async () => {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS email_message_deals (
          gmail_message_id TEXT NOT NULL REFERENCES email_messages(gmail_message_id) ON DELETE CASCADE,
          deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
          linked_by_email TEXT,
          linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (gmail_message_id, deal_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS email_message_deals_deal_idx ON email_message_deals (deal_id)`;
    } catch (err) {
      messageDealsTableEnsured = null;
      console.warn('[email_message_deals] ensure failed', err.message);
    }
  })();
  return messageDealsTableEnsured;
}

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.readonly',
];

export function gmailRedirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/crm/gmail/callback`;
}

export const makeId = (prefix) =>
  prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

export function trimOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

export function lowerOrNull(v) {
  const s = trimOrNull(v);
  return s ? s.toLowerCase() : null;
}

export function numberOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
