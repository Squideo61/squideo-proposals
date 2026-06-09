// Shared helpers used across the per-resource CRM handlers.
import sql from '../db.js';
import crypto from 'crypto';

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

// Self-heal for db/migrations/20260519_deal_contacts.sql — secondary contacts
// per deal. Same module-level cache pattern as ensureMessageDealsTable.
let dealContactsTableEnsured = null;
export async function ensureDealContactsTable() {
  if (dealContactsTableEnsured) return dealContactsTableEnsured;
  dealContactsTableEnsured = (async () => {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS deal_contacts (
          deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
          contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          role TEXT NOT NULL DEFAULT 'secondary',
          added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          added_by TEXT,
          PRIMARY KEY (deal_id, contact_id)
        )
      `;
      // Patch tables created by an earlier version that lacked these columns.
      await sql`ALTER TABLE deal_contacts ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'secondary'`;
      await sql`ALTER TABLE deal_contacts ADD COLUMN IF NOT EXISTS added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
      await sql`ALTER TABLE deal_contacts ADD COLUMN IF NOT EXISTS added_by TEXT`;
      await sql`CREATE INDEX IF NOT EXISTS deal_contacts_contact_idx ON deal_contacts (contact_id)`;
    } catch (err) {
      dealContactsTableEnsured = null;
      console.warn('[deal_contacts] ensure failed', err.message);
    }
  })();
  return dealContactsTableEnsured;
}

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.readonly',
];

// Drive-backed deal files (a per-deal folder in a shared Team Drive) turn on
// only when DEAL_DRIVE_ROOT_ID is set. Until then we don't request the Drive
// scope, so existing Gmail-only consent is untouched.
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

export function driveFilesEnabled() {
  return !!process.env.DEAL_DRIVE_ROOT_ID;
}

// The Google scopes to request on connect — Gmail always, plus Drive when
// Drive-backed files are enabled.
export function googleScopes() {
  return driveFilesEnabled() ? [...GMAIL_SCOPES, DRIVE_SCOPE] : [...GMAIL_SCOPES];
}

export function gmailRedirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/crm/gmail/callback`;
}

// `prefix_<timestamp>_<random>`. The timestamp keeps ids loosely sortable for
// debugging; the random suffix is from a CSPRNG (72 bits) so ids that double as
// bearer capabilities (e.g. proposal ids — read/signed unauthenticated by id)
// aren't predictable. Never use Math.random() here.
export const makeId = (prefix) =>
  prefix + '_' + Date.now() + '_' + crypto.randomBytes(9).toString('hex');

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
