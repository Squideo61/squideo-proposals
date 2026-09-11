// Demo academies: the Squideo Academies built for a prospect to try, followed
// from Sales → Demos.
//
// The academy platform owns them (squideo-lms, crm/demos there): their type,
// the logins handed out, and every visit. The CRM adds the deal each one is
// for, and raises the alert when a prospect opens one — the platform pushes the
// sign-in here (recordDemoOpened, via api/academy-billing/demo-opened) rather
// than emailing it, so the alert follows the CRM's own notification settings
// and the visit lands on the deal's timeline.
//
//   GET  /api/crm/demo-academies                    the Demos page
//   GET  /api/crm/demo-academies/:id/visits         one demo's visit timeline
//   POST /api/crm/demo-academies/:id/link           { dealId | null }
//   POST /api/crm/demo-academies/:id/settings       { demoType?, notifyOnSignIn? }
//   POST /api/crm/demo-academies/:id/reset-visits   forget its visits (after a colleague looked)
//
// Named demo-academies, never "demos": the CRM already has a "[DEMO] Test
// Client" project (./demoScope.js), and the two must not be confused.

import sql from '../db.js';
import { trimOrNull, escapeHtml } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { isFreelancer } from './access.js';
import { APP_URL } from '../email.js';
import { sendNotification, ensureDemoNotificationDefaults } from '../notifications.js';
import {
  demoAcademyVisits, getDemoAcademy, listDemoAcademies, patchDemoAcademy, resetDemoAcademyVisits,
} from '../lms.js';
import { DEMO_TYPES, cleanDemoOpened, demoOpenedMessage } from './demoAcademyRules.js';

const VIEW_PERMS = ['demos.view', 'demos.manage'];
const MANAGE_PERMS = ['demos.manage'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function can(user, perms) {
  const role = await getRole(user?.role);
  return perms.some((p) => hasPermission(role, p));
}

const lmsError = (res, err) => res.status(err?.status || 502).json({
  error: err?.message || 'The academy platform could not be reached.',
});

// Each demo with the deal it is linked to, looked up here: the platform only
// holds the deal's id.
async function withDeals(demos) {
  const ids = [...new Set(demos.map((d) => d.crmDealId).filter(Boolean))];
  let deals = [];
  if (ids.length) {
    try {
      deals = await sql`
        SELECT d.id, d.title, d.stage, d.owner_email, d.company_id, c.name AS company_name
          FROM deals d LEFT JOIN companies c ON c.id = d.company_id
         WHERE d.id = ANY(${ids})`;
    } catch (err) {
      console.warn('[demo-academies] deal lookup failed', err?.message || err);
    }
  }
  const byId = new Map(deals.map((d) => [d.id, d]));
  return demos.map((d) => {
    const deal = d.crmDealId ? byId.get(d.crmDealId) : null;
    return {
      ...d,
      deal: d.crmDealId
        ? (deal
          ? { id: deal.id, title: deal.title, stage: deal.stage, ownerEmail: deal.owner_email, companyName: deal.company_name || null }
          : { id: d.crmDealId, title: null, missing: true })
        : null,
    };
  });
}

async function composeOne(id) {
  const demo = await getDemoAcademy(id);
  return demo ? (await withDeals([demo]))[0] : null;
}

export async function demoAcademiesRoute(req, res, id, action, user) {
  const role = await getRole(user?.role);
  if (isFreelancer(role)) return res.status(403).json({ error: 'Your account cannot see demos.' });
  if (!(await can(user, VIEW_PERMS))) {
    return res.status(403).json({ error: 'You do not have permission to see the demos.' });
  }

  if (!id) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const demos = await withDeals(await listDemoAcademies());
      return res.status(200).json({ demos, canManage: await can(user, MANAGE_PERMS) });
    } catch (err) { return lmsError(res, err); }
  }
  if (!UUID_RE.test(String(id))) return res.status(404).json({ error: 'Demo not found' });

  if (action === 'visits' && req.method === 'GET') {
    try { return res.status(200).json({ visits: await demoAcademyVisits(id) }); } catch (err) { return lmsError(res, err); }
  }

  if (req.method !== 'POST' || !['link', 'settings', 'reset-visits'].includes(action)) {
    return res.status(404).json({ error: 'Unknown action' });
  }
  if (!(await can(user, MANAGE_PERMS))) {
    return res.status(403).json({ error: 'You do not have permission to change the demos.' });
  }

  try {
    if (action === 'link') {
      const dealId = trimOrNull(req.body?.dealId);
      let companyId = null;
      if (dealId) {
        const [deal] = await sql`SELECT id, company_id FROM deals WHERE id = ${dealId}`;
        if (!deal) return res.status(400).json({ error: 'That deal is not in the CRM.' });
        companyId = deal.company_id || null;
      }
      // The company comes with the deal, so the academy's company link (used
      // on the company page) never disagrees with the deal it is for.
      await patchDemoAcademy(id, { crmDealId: dealId, crmCompanyId: companyId });
      return res.status(200).json({ demo: await composeOne(id) });
    }

    if (action === 'settings') {
      const body = {};
      if ('demoType' in (req.body || {})) {
        const t = req.body.demoType;
        if (t !== null && !DEMO_TYPES.includes(t)) {
          return res.status(400).json({ error: 'The type must be induction, consent or training.' });
        }
        body.demoType = t;
      }
      if (typeof req.body?.notifyOnSignIn === 'boolean') body.notifyOnSignIn = req.body.notifyOnSignIn;
      if (!Object.keys(body).length) return res.status(400).json({ error: 'Nothing to change.' });
      await patchDemoAcademy(id, body);
      return res.status(200).json({ demo: await composeOne(id) });
    }

    // reset-visits
    const r = await resetDemoAcademyVisits(id);
    return res.status(200).json({ removed: r.removed ?? 0, demo: r.demo ? (await withDeals([r.demo]))[0] : await composeOne(id) });
  } catch (err) { return lmsError(res, err); }
}

/**
 * A prospect has opened a demo academy: the platform tells us (once a sitting,
 * demo logins only — it decides that). Raise the alert, and put the visit on
 * the linked deal's timeline. Throws with a .status when the event is not one.
 */
export async function recordDemoOpened(body) {
  const event = cleanDemoOpened(body);
  if (!event) {
    const e = new Error('Not a demo-opened event.');
    e.status = 400;
    throw e;
  }
  let deal = null;
  if (event.crmDealId) {
    try {
      [deal] = await sql`SELECT id, title, owner_email FROM deals WHERE id = ${event.crmDealId}`;
    } catch { deal = null; }
  }
  const { subject, body: text } = demoOpenedMessage(event, deal);
  const link = `${APP_URL}/#/demos`;
  await ensureDemoNotificationDefaults();
  await sendNotification('demo.opened', {
    subject,
    text: `${text}\n\nSee the visit: ${link}`,
    html: `<p>${escapeHtml(text)}</p><p><a href="${link}">See the visit on Demos</a></p>`,
    inApp: {
      title: subject,
      body: text,
      link: '#/demos',
      // A prospect coming back three times in an afternoon is one row, not three.
      coalesce: { group: `demo-opened:${event.tenantId}`, summaryTitle: `${event.academyName} has opened their demo {n} times`, windowMinutes: 12 * 60 },
    },
  });
  if (deal) {
    try {
      await sql`
        INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
        VALUES (${deal.id}, 'demo_visit', ${JSON.stringify({
          academy: event.academyName, login: event.login, device: event.device, demoType: event.demoType,
        })}::jsonb, NULL)`;
    } catch (err) {
      console.warn('[demo-academies] deal event failed', err?.message || err);
    }
  }
  return { ok: true, deal: deal ? deal.id : null };
}
