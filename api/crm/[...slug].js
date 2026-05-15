// CRM dispatcher — routes /api/crm/:resource/... to the per-resource handler
// in api/_lib/crm/<resource>.js. Kept as a single Vercel function so the
// project stays well under the 12-function cap.
import { cors, requireAuth } from '../_lib/middleware.js';
import { companiesRoute } from '../_lib/crm/companies.js';
import { contactsRoute } from '../_lib/crm/contacts.js';
import { dealsRoute } from '../_lib/crm/deals.js';
import { tasksRoute, taskDoneLinkRoute } from '../_lib/crm/tasks.js';
import { triageRoute } from '../_lib/crm/triage.js';
import { emailsRoute } from '../_lib/crm/emails.js';
import { threadsRoute } from '../_lib/crm/threads.js';
import { templatesRoute } from '../_lib/crm/templates.js';
import { commentsRoute } from '../_lib/crm/comments.js';
import { paymentsRoute } from '../_lib/crm/payments.js';
import { invoicesRoute } from '../_lib/crm/invoices.js';
import { retainersRoute } from '../_lib/crm/retainers.js';
import { xeroContactsRoute } from '../_lib/crm/xeroContacts.js';
import { gmailRoute, gmailCallback } from '../_lib/crm/gmail.js';
import { gmailPush } from '../_lib/crm/gmailPush.js';
import { gmailBackfill } from '../_lib/crm/gmailBackfill.js';
import { cronHandler } from '../_lib/crm/cron.js';
import { resolveClientRoute } from '../_lib/crm/clientResolver.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Parse the path. Vercel's [...slug] catch-all in this project only matches
  // SINGLE-segment paths reliably (multi-segment 404s), so vercel.json
  // rewrites flatten /api/crm/:resource/:id/:action into
  // /api/crm/:resource?_id=:id&_action=:action and we recover id/action from
  // the query string here. Direct calls (e.g. /api/crm/companies, no id)
  // also work because the rewrites are conditional on having extra segments.
  const urlPath = (req.url || '').split('?')[0];
  const qs = (req.url || '').split('?')[1] || '';
  const queryParams = new URLSearchParams(qs);
  const segs = urlPath.split('/').filter(Boolean).slice(2); // strip 'api', 'crm'
  const resource = segs[0] || null;
  const id = segs[1] || queryParams.get('_id') || null;
  const action = segs[2] || queryParams.get('_action') || null;
  const subaction = queryParams.get('_subaction') || null;

  if (!resource) return res.status(404).json({ error: 'Not found' });

  // Cron sweep — auth via shared secret in Authorization header so the route
  // can be hit by Vercel cron without a JWT. After the rewrite, the cron
  // task name lands in `id` (e.g. /api/crm/cron/task-reminders → id='task-reminders').
  if (resource === 'cron') {
    return cronHandler(req, res, id || action);
  }

  // Gmail OAuth callback is hit by Google after consent — no JWT to send,
  // CSRF protection comes from the `state` token we stored before redirect.
  if (resource === 'gmail' && id === 'callback') {
    return gmailCallback(req, res);
  }

  // Pub/Sub push: Google calls this with a service-account-signed JWT; the
  // handler verifies it itself, so no app-level auth.
  if (resource === 'gmail' && id === 'push') {
    return gmailPush(req, res);
  }

  // One-click "Mark task done" from a reminder email. Auth via signed token
  // in the URL, not a session — recipients click straight from their inbox.
  if (resource === 'tasks' && action === 'done-link') {
    return taskDoneLinkRoute(req, res);
  }

  // Backfill self-chain. The first invocation runs under the user's session
  // via gmailRoute() below; subsequent pages are invoked from the server
  // itself (fire-and-forget fetch) and authenticate with CRON_SECRET because
  // there's no session in those background calls.
  if (resource === 'gmail' && id === 'backfill') {
    const auth = req.headers.authorization || '';
    if (auth === 'Bearer ' + (process.env.CRON_SECRET || '')) {
      return gmailBackfill(req, res, /* userFromSession */ null);
    }
    // No CRON_SECRET → fall through to the authenticated user path below.
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    switch (resource) {
      case 'companies': return await companiesRoute(req, res, id, action, user);
      case 'contacts':  return await contactsRoute(req, res, id, action, user);
      case 'deals':     return await dealsRoute(req, res, id, action, user, subaction);
      case 'tasks':     return await tasksRoute(req, res, id, action, user);
      case 'gmail':     return await gmailRoute(req, res, id, action, user);
      case 'triage':    return await triageRoute(req, res, id, action, user);
      case 'emails':    return await emailsRoute(req, res, id, action, user);
      case 'threads':   return await threadsRoute(req, res, id, action, user);
      case 'templates': return await templatesRoute(req, res, id, action, user);
      case 'comments':  return await commentsRoute(req, res, id, action, user);
      case 'payments':  return await paymentsRoute(req, res, id, action, user);
      case 'invoices':   return await invoicesRoute(req, res, id, action, user);
      case 'retainers':  return await retainersRoute(req, res, id, action, user);
      case 'xero-contacts': return await xeroContactsRoute(req, res, id, action, user);
      case 'resolve-client': return await resolveClientRoute(req, res, id, action, user);
      default:           return res.status(404).json({ error: 'Unknown resource: ' + resource });
    }
  } catch (err) {
    console.error('[crm] unhandled', { resource, id, action, method: req.method, err });
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
