// Permission catalog and helpers. The list is intentionally frozen in code
// (not in the DB) so swapping it requires a deploy — preventing typos in role
// editors from silently locking out endpoints. Each entry has a stable slug,
// a human label, and a group (used by the role-editor UI to lay things out).
//
// `'*'` is a wildcard permission. A role whose permissions array contains
// `'*'` is treated as having every slug — used by the seeded Admin role so
// new permissions added in future deploys automatically apply to it.

export const PERMISSIONS = [
  { slug: 'users.manage',         group: 'Workspace',  label: 'Manage users + invites' },
  { slug: 'roles.manage',         group: 'Workspace',  label: 'Manage roles + permissions' },
  { slug: 'settings.manage',      group: 'Workspace',  label: 'Edit workspace settings' },
  { slug: 'finance.manage',       group: 'Workspace',  label: 'View + edit business finance (Cash Flow, Performance, Storage costs)' },
  { slug: 'finance.pending_payments', group: 'Workspace', label: 'View Pending Payments + mark them predicted (no other finance)' },
  { slug: 'finance.notifications',group: 'Workspace',  label: 'See the sales & finance notifications bell (£)' },
  { slug: 'marketing.access',     group: 'Workspace',  label: 'View Marketing (lead attribution + ad ROAS)' },

  { slug: 'proposals.manage_all', group: 'Proposals',  label: 'Edit / delete any proposal' },
  { slug: 'signatures.manage_all',group: 'Proposals',  label: 'Edit / delete any signature record' },
  { slug: 'templates.manage',     group: 'Proposals',  label: 'Edit proposal templates' },
  { slug: 'payments.manage',      group: 'Proposals',  label: 'Edit / void proposal payments' },

  { slug: 'deals.manage_all',     group: 'CRM',        label: 'Edit / delete any deal' },
  { slug: 'contacts.manage_all',  group: 'CRM',        label: 'Edit / delete any contact' },
  { slug: 'companies.manage_all', group: 'CRM',        label: 'Edit / delete any company' },
  { slug: 'tasks.manage_all',     group: 'CRM',        label: 'Edit / delete any task' },
  { slug: 'comments.manage_all',  group: 'CRM',        label: 'Edit / delete any comment' },
  { slug: 'invoices.manage',      group: 'CRM',        label: 'Manage CRM invoices + Xero sync' },
  { slug: 'quote_requests.manage',group: 'CRM',        label: 'View + qualify quote requests' },
  { slug: 'partner_credits.manage', group: 'CRM',      label: 'Manage partner credits' },

  { slug: 'revisions.access',     group: 'Revisions',  label: 'Access the video revisions section' },

  { slug: 'production.access',    group: 'Projects',   label: 'Access the production board' },
  { slug: 'schedule.access',      group: 'Projects',   label: 'See own producer calendar + book annual leave' },
  { slug: 'schedule.manage',      group: 'Projects',   label: 'Manage the weekly schedule — see all producers, Master view, drag/assign/durations' },
  { slug: 'schedule.approve_leave', group: 'Projects', label: 'Approve annual leave + edit allowances' },
];

const VALID_SLUGS = new Set(PERMISSIONS.map(p => p.slug));

export function isValidPermission(slug) {
  return slug === '*' || VALID_SLUGS.has(slug);
}

// Returns true if the role row grants the permission. A role row is
// `{ id, name, permissions: string[], notification_defaults }` — typically a
// raw row from `SELECT * FROM roles WHERE id = ...`. Wildcard `'*'` always
// wins. Passing `null` for the role (e.g. user with no role) returns false.
export function hasPermission(role, slug) {
  if (!role || !Array.isArray(role.permissions)) return false;
  if (role.permissions.includes('*')) return true;
  return role.permissions.includes(slug);
}

// Same as hasPermission but takes the raw permissions array directly — handy
// in the frontend where we ship just the array on the session.
export function permissionsInclude(permissions, slug) {
  if (!Array.isArray(permissions)) return false;
  if (permissions.includes('*')) return true;
  return permissions.includes(slug);
}
