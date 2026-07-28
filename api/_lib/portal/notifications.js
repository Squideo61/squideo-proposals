// Client-facing (portal) notification feed. Separate from the staff notification
// system (api/_lib/notifications.js), which is FK'd to users(email) and can't
// target clients. Rows live in portal_notifications, keyed to portal_users(id).
//
// Recipients: a deal's alerts reach every ACTIVE portal member of the deal's
// company. A freshly-invited client has no portal_users row yet (invite still
// pending) — the accompanying email carries that case; the feed picks up once
// they accept and their tasks already render on the dashboard.

import sql from '../db.js';
import { makeId } from '../crm/shared.js';
import { ensurePortalTables } from './db.js';

// Re-exported for callers that already import from this module; the definition
// lives in a DB-free file so it can be unit-tested without a DB connection.
export { serialisePortalNotification } from './notificationShape.js';

// Active portal members of a company: [{ id, email, name }].
export async function resolvePortalRecipients(companyId) {
  if (!companyId) return [];
  return sql`
    SELECT pu.id, pu.email, pu.name
      FROM portal_memberships m
      JOIN portal_users pu ON pu.id = m.portal_user_id
     WHERE m.company_id = ${companyId}
       AND m.disabled_at IS NULL
       AND pu.disabled_at IS NULL
     ORDER BY m.created_at ASC
  `.catch(() => []);
}

// Insert one feed row per target. Pass either portalUserId (single) or companyId
// (fans out to all active members). Best-effort — never throws (a failed feed
// write must not break the action that triggered it).
export async function notifyPortalUser({ portalUserId, companyId, key, title, body, link, dealId }) {
  try {
    await ensurePortalTables();
    let recipients;
    if (portalUserId) {
      recipients = [{ id: portalUserId }];
    } else {
      recipients = await resolvePortalRecipients(companyId);
    }
    if (!recipients.length) return 0;
    for (const r of recipients) {
      await sql`
        INSERT INTO portal_notifications (id, portal_user_id, company_id, deal_id, notification_key, title, body, link)
        VALUES (${makeId('ntf')}, ${r.id}, ${companyId || null}, ${dealId || null}, ${key || null}, ${title}, ${body || null}, ${link || null})
      `;
    }
    return recipients.length;
  } catch (err) {
    console.warn('[portal] notifyPortalUser failed', err.message);
    return 0;
  }
}
