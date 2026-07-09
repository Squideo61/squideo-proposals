import { permissionsInclude } from './permissions.js';

// Single source of truth for "what a full-shell user is allowed to see", shared
// by the top-nav (which shows/hides items) and the App route guard (which
// blocks the actual route when someone deep-links / types a URL). Keep the two
// in lockstep by deriving both from navFlags(): if the nav hides an item, the
// route must block it too.
//
// NOTE: this covers the MAIN app shell only. Producer / copywriter / freelancer
// and marketing accounts render their own scoped shells in App.jsx, which
// already fall back to an in-scope page for any out-of-scope route.
export function navFlags(perms) {
  const canBusiness = permissionsInclude(perms, 'finance.manage');
  return {
    canRevisions: permissionsInclude(perms, 'revisions.access'),
    canProduction: permissionsInclude(perms, 'production.access'),
    canSchedule: permissionsInclude(perms, 'schedule.access'),
    canQuoteRequests: permissionsInclude(perms, 'quote_requests.manage'),
    canAdmin: permissionsInclude(perms, 'users.manage')
      || permissionsInclude(perms, 'roles.manage')
      || permissionsInclude(perms, 'settings.manage'),
    canBusiness,
    // Pending-Payments-only access (Project/Production Managers) still reaches
    // the Finance page (they just see the one tab).
    canPendingPayments: canBusiness || permissionsInclude(perms, 'finance.pending_payments'),
    canMarketing: permissionsInclude(perms, 'marketing.access'),
    canInvoices: permissionsInclude(perms, 'invoices.manage'),
  };
}

// view -> predicate(flags). A view absent from this map is open to any
// signed-in full-shell user (Proposals, Pipeline, Overview, Tasks, Contacts,
// Deals, Emails, Sales Insights, Partners & Credits, the proposal Builder,
// client preview, etc. — exactly the nav items shown without a permission gate).
const VIEW_GUARDS = {
  finance:          (f) => f.canPendingPayments,
  performance:      (f) => f.canPendingPayments,
  marketing:        (f) => f.canMarketing,
  'quote-requests': (f) => f.canQuoteRequests,
  production:       (f) => f.canProduction,
  'prod-dashboard': (f) => f.canProduction,
  projects:         (f) => f.canProduction,
  revisions:        (f) => f.canRevisions,
  storyboards:      (f) => f.canRevisions,
  schedule:         (f) => f.canSchedule,
  'xero-duplicates': (f) => f.canInvoices,
  admin:            (f) => f.canAdmin,
};

// Can this permission set reach this view? Unknown/unguarded views are allowed.
export function canAccessView(view, perms) {
  const guard = VIEW_GUARDS[view];
  if (!guard) return true;
  return !!guard(navFlags(perms || []));
}
