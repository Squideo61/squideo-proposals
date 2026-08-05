// Which accounts are ours rather than a client's.
//
// Testing anything client-facing means using it, and every one of those uses
// lands in Marketing as a lead. One rule, in one place, so the course numbers
// and the portal numbers can't disagree about who counts.
//
// Two mechanisms:
//   portal_users.internal = TRUE — an explicit flag, for personal addresses
//     nobody could infer from the address itself.
//   the @squideo domains — applied at query time, so the next person who tests
//     with their work address is excluded without anyone remembering to run SQL.
//
// Neither is the same as disabling an account: these are live logins we keep
// using. They only mean "don't count this as a lead".

import sql from './db.js';

// ILIKE patterns rather than a regex, so they can go straight into SQL.
export const INTERNAL_EMAIL_PATTERNS = ['%@squideo.co.uk', '%@squideo.com'];

export function isInternalEmail(email, flaggedEmails = []) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  if (flaggedEmails.includes(e)) return true;
  return /@(squideo\.co\.uk|squideo\.com)$/i.test(e);
}

// Portal user ids to exclude. Most of what gets counted (course progress,
// briefs, sign-ins) hangs off portal_user_id and never touches portal_users, so
// a list of ids applied identically everywhere is the only way the tiles and
// the tables can agree.
export async function internalPortalUserIds() {
  const rows = await sql`
    SELECT id FROM portal_users
     WHERE COALESCE(internal, FALSE)
        OR email ILIKE '%@squideo.co.uk'
        OR email ILIKE '%@squideo.com'
  `.catch(() => []);
  return rows.map((r) => r.id);
}

// The addresses themselves, for tables keyed by email rather than by portal
// user — course_signups is one, and a signup can exist before any account does.
export async function internalEmails() {
  const rows = await sql`
    SELECT LOWER(email) AS email FROM portal_users
     WHERE COALESCE(internal, FALSE)
        OR email ILIKE '%@squideo.co.uk'
        OR email ILIKE '%@squideo.com'
  `.catch(() => []);
  return rows.map((r) => r.email).filter(Boolean);
}
