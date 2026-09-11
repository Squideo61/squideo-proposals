// The academy platform's way into the CRM: to take a card payment, and to say
// a prospect has opened their demo.
//
// squideo-lms calls this, server to server, with the same shared secret the
// CRM uses to reach it (LMS_API_SECRET here, CRM_API_SECRET there). The
// academy is always the one the platform resolved from the admin's own host,
// so an admin can only ever pay for, or manage, their own academy.
//
//   POST /api/academy-billing/checkout      { tenantId, academyName, plan, billingPeriod, email, name, trial, successUrl, cancelUrl }
//   POST /api/academy-billing/portal        { tenantId, returnUrl }
//   POST /api/academy-billing/change        { tenantId, plan, billingPeriod }
//   POST /api/academy-billing/demo-opened   { tenantId, academyName, demoType, login, role, device, at, crmDealId, url, cmsUrl }
//
// The card work is in api/_lib/crm/academyCards.js; the demo alert in
// api/_lib/crm/demoAcademies.js.

import { lmsCallerProblem } from '../_lib/lms.js';
import {
  changeAcademyCardPlan, createAcademyCheckout, createAcademyPortal, stripeClient,
} from '../_lib/crm/academyCards.js';
import { recordDemoOpened } from '../_lib/crm/demoAcademies.js';

const ACTIONS = {
  checkout: createAcademyCheckout,
  portal: createAcademyPortal,
  change: changeAcademyCardPlan,
};

// Events that are not payments, and so never need Stripe set up.
const EVENTS = {
  'demo-opened': recordDemoOpened,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const problem = lmsCallerProblem(req.headers.authorization);
  if (problem) return res.status(problem.status).json({ error: problem.error });
  const action = req.query?.action;
  const event = EVENTS[action];
  const run = ACTIONS[action];
  if (!event && !run) return res.status(404).json({ error: 'Not found' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (event) return res.status(200).json(await event(body));
    return res.status(200).json(await run(stripeClient(), body));
  } catch (err) {
    // A reason with a status is written for the admin who will read it; the
    // rest is logged here and put plainly.
    if (err?.status) return res.status(err.status).json({ error: err.message });
    console.error('[academy-billing]', action, err);
    return res.status(502).json({
      error: event ? 'The CRM could not record that.' : 'Card payments are not working right now. Try again in a moment.',
    });
  }
}
