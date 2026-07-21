// Shared helpers used across the per-resource CRM handlers.
import sql from '../db.js';
import crypto from 'crypto';

// Self-heal for db/migrations/20260721_deal_reference.sql — the human-readable
// deal reference (YYMM-NNN, also the project number) and the per-deal video
// ordinal it extends (2607-014-01). Includes both backfills, which only touch
// rows still NULL, so this is safe to run repeatedly. Lives here rather than in
// deals.js because production.js needs it too and imports the other way round.
let dealReferenceEnsured = null;
export function ensureDealReference() {
  if (dealReferenceEnsured) return dealReferenceEnsured;
  dealReferenceEnsured = (async () => {
    let ok = true;

    // Deal half. The backfill continues from the highest sequence already
    // issued in each month — numbering un-referenced deals from 1 would hand
    // out a reference an existing deal already holds, which is exactly what
    // took the CRM down: deals inserted by other code paths (portal onboarding,
    // project create, quote-form leads) arrive with a NULL reference, so this
    // runs against a live table, not just once at migration time.
    try {
      await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS reference TEXT`;
      await sql`
        WITH issued AS (
          SELECT substring(reference from 1 for 4) AS ym,
                 MAX(substring(reference from 6)::int) AS max_seq
            FROM deals
           WHERE reference ~ '^\\d{4}-\\d+$'
           GROUP BY substring(reference from 1 for 4)
        ),
        numbered AS (
          SELECT d.id,
                 to_char(COALESCE(d.created_at, NOW()), 'YYMM') AS ym,
                 COALESCE(i.max_seq, 0)
                   + row_number() OVER (PARTITION BY to_char(COALESCE(d.created_at, NOW()), 'YYMM')
                                            ORDER BY d.created_at, d.id) AS seq
            FROM deals d
            LEFT JOIN issued i ON i.ym = to_char(COALESCE(d.created_at, NOW()), 'YYMM')
           WHERE d.reference IS NULL
        )
        UPDATE deals d
           SET reference = n.ym || '-' ||
                 CASE WHEN n.seq < 1000 THEN lpad(n.seq::text, 3, '0') ELSE n.seq::text END
          FROM numbered n
         WHERE d.id = n.id
      `;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS deals_reference_idx ON deals (reference)`;
    } catch (err) {
      ok = false;
      console.warn('[deal reference] deal half skipped', err.message);
    }

    // Video half. project_videos is created by ensureProductionSchema(), which
    // a deals-only request never runs, so its absence must not stop the rest.
    try {
      await sql`ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS video_number INTEGER`;
      await sql`
        WITH issued AS (
          SELECT deal_id, MAX(video_number) AS max_num
            FROM project_videos WHERE video_number IS NOT NULL GROUP BY deal_id
        ),
        numbered AS (
          SELECT pv.id,
                 COALESCE(i.max_num, 0)
                   + row_number() OVER (PARTITION BY pv.deal_id
                                            ORDER BY pv.sort_order, pv.created_at, pv.id) AS num
            FROM project_videos pv
            LEFT JOIN issued i ON i.deal_id = pv.deal_id
           WHERE pv.video_number IS NULL
        )
        UPDATE project_videos pv
           SET video_number = n.num
          FROM numbered n
         WHERE pv.id = n.id
      `;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS project_videos_number_idx ON project_videos (deal_id, video_number)`;
    } catch (err) {
      ok = false;
      console.warn('[deal reference] video half skipped', err.message);
    }

    // Never cache a partial run as done, and never reject: this runs at the top
    // of the deals and production routes, so throwing here 500s the whole CRM.
    // A missing reference is a cosmetic gap; an unreachable pipeline is not.
    if (!ok) dealReferenceEnsured = null;
  })();
  return dealReferenceEnsured;
}

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

// Self-heal for db/migrations/20260715_email_thread_deal_blocks.sql — the
// "keep this thread off this deal" list written when a user manually unlinks.
// Read by the auto-link resolver (gmailSync) and the inbox chip resolver so a
// later reply can't rebuild a link the user deliberately removed. Same
// module-level cache pattern as ensureMessageDealsTable.
let threadDealBlocksTableEnsured = null;
export async function ensureThreadDealBlocksTable() {
  if (threadDealBlocksTableEnsured) return threadDealBlocksTableEnsured;
  threadDealBlocksTableEnsured = (async () => {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS email_thread_deal_blocks (
          gmail_thread_id TEXT NOT NULL,
          deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
          blocked_by TEXT,
          blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (gmail_thread_id, deal_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS email_thread_deal_blocks_thread_idx ON email_thread_deal_blocks (gmail_thread_id)`;
    } catch (err) {
      threadDealBlocksTableEnsured = null;
      console.warn('[email_thread_deal_blocks] ensure failed', err.message);
    }
  })();
  return threadDealBlocksTableEnsured;
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

// Many-to-many contact↔organisation memberships. We KEEP contacts.company_id as
// the contact's PRIMARY organisation (deals, Xero links and lifetime-value
// rollups all still key off it); this table holds the FULL set of memberships
// (a superset that includes the primary). Self-heals + backfills every existing
// primary company as a membership, so reads can treat the join table as
// authoritative for "all of a contact's organisations".
let contactCompaniesEnsured = null;
export async function ensureContactCompanies() {
  if (contactCompaniesEnsured) return contactCompaniesEnsured;
  contactCompaniesEnsured = (async () => {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS contact_companies (
          contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (contact_id, company_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS contact_companies_company_idx ON contact_companies (company_id)`;
      // Backfill the existing single-company links so the join table is the
      // complete picture from day one. Idempotent.
      await sql`
        INSERT INTO contact_companies (contact_id, company_id)
        SELECT c.id, c.company_id FROM contacts c
         WHERE c.company_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM companies co WHERE co.id = c.company_id)
        ON CONFLICT DO NOTHING
      `;
    } catch (err) {
      contactCompaniesEnsured = null;
      console.warn('[contact_companies] ensure failed', err.message);
    }
  })();
  return contactCompaniesEnsured;
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

// Calendar scopes power the Intro Call booking feature: freeBusy reads each
// staff member's availability, calendar.events creates the booked call (with a
// Meet link) on the PM's calendar. Always requested now, so newly-connected
// users grant them — existing Gmail-only users keep working but must reconnect
// to gain Calendar (the UI flags `needsCalendar` by comparing stored scopes).
export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
];

export function driveFilesEnabled() {
  return !!process.env.DEAL_DRIVE_ROOT_ID;
}

// True when a stored scope string already covers Calendar — used by the gmail
// status endpoint so the UI can prompt long-connected users to reconnect.
export function scopesCoverCalendar(scopeStr) {
  const have = String(scopeStr || '').split(/\s+/).filter(Boolean);
  return CALENDAR_SCOPES.every(s => have.includes(s));
}

// The Google scopes to request on connect — Gmail + Calendar always, plus
// Drive when Drive-backed files are enabled.
export function googleScopes() {
  const base = [...GMAIL_SCOPES, ...CALENDAR_SCOPES];
  return driveFilesEnabled() ? [...base, DRIVE_SCOPE] : base;
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
