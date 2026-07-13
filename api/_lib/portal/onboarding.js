// Portal onboarding: the post-signing welcome invite, plus the shared
// create-invite helper used by client self-invites and CRM staff invites.
//
// sendPortalWelcome is called from api/signatures/[id].js inside a best-effort
// try/catch — it must never throw into the sign flow, so every step here is
// defensive. The CRM "Resend portal invite" action is the recovery path when
// something (missing company, email outage) stops the automatic send.

import crypto from 'crypto';
import sql from '../db.js';
import { sendMail } from '../email.js';
import { makeId, trimOrNull, lowerOrNull } from '../crm/shared.js';
import { ensurePortalTables } from './db.js';
import { createRawToken, hashToken } from './auth.js';
import {
  PORTAL_URL,
  portalWelcomeHtml,
  portalProjectAddedHtml,
  portalTeamInviteHtml,
} from './emails.js';

const INVITE_DAYS = 14;

export function inviteUrlFor(rawToken) {
  return `${PORTAL_URL}?invite=${encodeURIComponent(rawToken)}`;
}

// Create (or refresh) an invite for (email, company). An unaccepted pending
// invite for the same pair is re-keyed and re-dated rather than duplicated, so
// "resend" always yields exactly one live link. Returns { invite, rawToken }.
export async function createPortalInvite({ email, companyId, prefill = null, invitedBy = null }) {
  await ensurePortalTables();
  const cleanEmail = lowerOrNull(email);
  if (!cleanEmail || !companyId) throw new Error('email and companyId required');

  const rawToken = createRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const existing = await sql`
    SELECT id FROM portal_invites
     WHERE email = ${cleanEmail} AND company_id = ${companyId}
       AND accepted_at IS NULL AND revoked_at IS NULL
     ORDER BY created_at DESC LIMIT 1
  `;
  let inviteId;
  if (existing.length) {
    inviteId = existing[0].id;
    await sql`
      UPDATE portal_invites
         SET token_hash = ${tokenHash}, expires_at = ${expiresAt},
             prefill = COALESCE(${prefill ? JSON.stringify(prefill) : null}::jsonb, prefill),
             invited_by = ${invitedBy}
       WHERE id = ${inviteId}
    `;
  } else {
    inviteId = makeId('pin');
    await sql`
      INSERT INTO portal_invites (id, email, company_id, token_hash, prefill, invited_by, expires_at)
      VALUES (${inviteId}, ${cleanEmail}, ${companyId}, ${tokenHash},
              ${prefill ? JSON.stringify(prefill) : null}, ${invitedBy}, ${expiresAt})
    `;
  }
  return { inviteId, rawToken };
}

// Send a colleague invite (self-invite from the portal Team page, or a staff
// invite from the CRM). Throws on a send failure so callers can surface it.
export async function sendTeamInvite({ email, companyId, companyName, inviterName, invitedBy, prefill = null }) {
  const { rawToken } = await createPortalInvite({ email, companyId, prefill, invitedBy });
  await sendMail({
    to: email,
    subject: `${inviterName || 'A colleague'} invited you to ${companyName || 'your team'}'s Squideo portal`,
    html: portalTeamInviteHtml({ inviterName, companyName, inviteUrl: inviteUrlFor(rawToken) }),
    text: `${inviterName || 'A colleague'} invited you to ${companyName || 'your team'}'s Squideo Client Portal. Join here: ${inviteUrlFor(rawToken)} (expires in ${INVITE_DAYS} days)`,
    throwOnError: true,
  });
}

// Free-mail domains never name an organisation — "gmail's portal" is nonsense.
// A signer on a personal address falls back to the deal title instead.
const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
  'live.com', 'live.co.uk', 'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'protonmail.com', 'proton.me',
  'gmx.com', 'mail.com', 'msn.com', 'btinternet.com', 'sky.com', 'virginmedia.com',
]);

// An organisation name derived from the signer's email domain (acme.co.uk →
// "Acme"), or null for personal addresses.
function companyNameFromEmail(email) {
  if (!email || !email.includes('@')) return null;
  const domain = email.split('@')[1].trim().toLowerCase();
  if (!domain || FREEMAIL_DOMAINS.has(domain)) return null;
  const label = domain.split('.')[0];
  if (!label || label.length < 2) return null;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Resolve the deal's company, creating one when the deal has none — the org is
// the portal's anchor, so we can't invite without it. Naming, in order: the
// proposal's business name, the signer's work-email domain (acme.co.uk →
// "Acme"), then — for sole traders / personal addresses — the person's own name,
// falling back to their email. Never the deal title: a project name reads badly
// as an organisation.
export async function resolveCompanyForDeal(dealId, proposalData, signerEmail, signerName = null) {
  const [deal] = await sql`
    SELECT d.id, d.title, d.company_id, c.name AS company_name
      FROM deals d LEFT JOIN companies c ON c.id = d.company_id
     WHERE d.id = ${dealId}
  `;
  if (!deal) return null;
  if (deal.company_id) return { dealTitle: deal.title, companyId: deal.company_id, companyName: deal.company_name };

  const businessName = trimOrNull(proposalData?.contactBusinessName)
    || companyNameFromEmail(signerEmail)
    || trimOrNull(signerName)
    || trimOrNull(proposalData?.clientName)
    || trimOrNull(signerEmail);
  if (!businessName) return null;

  // Reuse an exact-name match before creating (mirrors clientResolver.js).
  const found = await sql`
    SELECT id, name FROM companies
     WHERE LOWER(TRIM(name)) = LOWER(${businessName})
     ORDER BY created_at ASC LIMIT 1
  `;
  let companyId, companyName;
  if (found.length) {
    companyId = found[0].id; companyName = found[0].name;
  } else {
    companyId = makeId('co');
    companyName = businessName;
    await sql`INSERT INTO companies (id, name) VALUES (${companyId}, ${businessName})`;
  }
  await sql`UPDATE deals SET company_id = ${companyId}, updated_at = NOW() WHERE id = ${dealId}`;
  return { dealTitle: deal.title, companyId, companyName };
}

// Find or create the CRM contact for the signer so the portal account links
// back to the CRM person record (best-effort prefill source).
async function resolveContactForSigner({ email, name, companyId }) {
  const cleanEmail = lowerOrNull(email);
  if (!cleanEmail) return null;
  const found = await sql`
    SELECT id, name, phone, title FROM contacts
     WHERE LOWER(email) = ${cleanEmail}
     ORDER BY created_at ASC LIMIT 1
  `;
  if (found.length) return found[0];
  const id = makeId('ct');
  await sql`
    INSERT INTO contacts (id, email, name, phone, title, company_id, provisional, source)
    VALUES (${id}, ${cleanEmail}, ${trimOrNull(name)}, NULL, NULL, ${companyId || null}, FALSE, 'portal_signup')
  `;
  return { id, name: trimOrNull(name), phone: null, title: null };
}

// The post-signing hook. Existing portal user → add the org membership and
// send a "new project in your portal" note; new client → invite with prefill.
export async function sendPortalWelcome({ dealId, proposalData, signerName, signerEmail }) {
  await ensurePortalTables();
  const email = lowerOrNull(signerEmail);
  if (!dealId || !email) return { sent: false, reason: 'missing dealId or signer email' };

  const org = await resolveCompanyForDeal(dealId, proposalData, email, signerName);
  if (!org) return { sent: false, reason: 'deal has no company and none could be created' };

  const contact = await resolveContactForSigner({ email, name: signerName, companyId: org.companyId });
  const projectTitle = proposalData?.proposalTitle || proposalData?.clientName || org.dealTitle || null;

  const existing = await sql`SELECT id, name FROM portal_users WHERE email = ${email}`;
  if (existing.length) {
    const pu = existing[0];
    const inserted = await sql`
      INSERT INTO portal_memberships (portal_user_id, company_id, invited_by)
      VALUES (${pu.id}, ${org.companyId}, 'system:signature')
      ON CONFLICT (portal_user_id, company_id) DO UPDATE SET disabled_at = NULL
      RETURNING portal_user_id
    `;
    if (inserted.length) {
      await sendMail({
        to: email,
        subject: `${projectTitle || 'Your new project'} is now in your Squideo portal`,
        html: portalProjectAddedHtml({ clientName: pu.name || signerName, projectTitle, companyName: org.companyName }),
        text: `${projectTitle || 'Your new project'} is now live in your Squideo Client Portal: ${PORTAL_URL}`,
      });
    }
    return { sent: true, existing: true };
  }

  const prefill = {
    name: trimOrNull(signerName) || contact?.name || null,
    phone: contact?.phone || null,
    jobTitle: contact?.title || null,
  };
  const { rawToken } = await createPortalInvite({
    email, companyId: org.companyId, prefill, invitedBy: 'system:signature',
  });
  await sendMail({
    to: email,
    subject: `Your Squideo Client Portal is ready${projectTitle ? ` — ${projectTitle}` : ''}`,
    html: portalWelcomeHtml({ clientName: prefill.name, projectTitle, inviteUrl: inviteUrlFor(rawToken) }),
    text: `Your Squideo Client Portal is ready. Set up your account (details prefilled): ${inviteUrlFor(rawToken)}`,
  });
  return { sent: true, existing: false };
}
