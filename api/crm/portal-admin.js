// Staff-side management of the customer portal: per-company members + invites
// (view / invite / resend / revoke / disable), per-deal extras offers +
// discount rate, and the "Resend portal invite" recovery action.
//
// Routed by direct file URL with an `op` query param (no rewrites needed):
//   GET  /api/crm/portal-admin?companyId=…        — members + pending invites
//   GET  /api/crm/portal-admin?dealId=…           — offers panel data
//   POST /api/crm/portal-admin?op=invite          — { companyId, email, name? }
//   POST /api/crm/portal-admin?op=resend-invite   — { inviteId }
//   POST /api/crm/portal-admin?op=revoke-invite   — { inviteId }
//   POST /api/crm/portal-admin?op=disable-member  — { portalUserId, companyId }
//   POST /api/crm/portal-admin?op=enable-member   — { portalUserId, companyId }
//   POST /api/crm/portal-admin?op=resend-welcome  — { dealId }
//   POST /api/crm/portal-admin?op=offer-create    — { dealId, kind, … }
//   POST /api/crm/portal-admin?op=offer-update    — { id, … }
//   POST /api/crm/portal-admin?op=offer-delete    — { id }
//   POST /api/crm/portal-admin?op=set-discount    — { dealId, discount }

import { getDownloadUrl } from '@vercel/blob';
import sql from '../_lib/db.js';
import { cors, requirePermission } from '../_lib/middleware.js';
import { PORTAL_ADMIN_PERMS, portalPreviewPerms } from '../_lib/permissions.js';
import { makeId, trimOrNull, lowerOrNull, numberOrNull, ensureDealContactsTable } from '../_lib/crm/shared.js';
import { sendMail } from '../_lib/email.js';
import { ensurePortalTables } from '../_lib/portal/db.js';
import { createRawToken, hashToken, signPortalPreviewToken } from '../_lib/portal/auth.js';
import { sendTeamInvite, createPortalInvite, inviteUrlFor, INVITE_DAYS } from '../_lib/portal/onboarding.js';
import { portalTeamInviteHtml, portalResetHtml, portalProjectTasksHtml, PORTAL_URL } from '../_lib/portal/emails.js';
import { emailLogoUrl } from '../_lib/portal/logo.js';
import { notifyPortalUser } from '../_lib/portal/notifications.js';
import { computeDealTasks } from '../_lib/portal/taskContext.js';
import { portalTimeline, dealSteps, companyStepsSummary } from '../_lib/portal/activity.js';
import { isFinalReleaseUnlocked } from '../_lib/crm/delivery.js';
import { computePortalOffers } from '../_lib/portal/extrasOffers.js';
import { ensureProductionSchema } from '../_lib/production.js';

// The permission policy lives in api/_lib/permissions.js alongside the catalog.

// Who the "Portal invite" modal offers to invite for a deal: its primary
// contact, its secondary contacts, and the proposal signer (who may not be a
// contact at all). Each is annotated with their current portal status so the
// modal can pre-tick only the people who still need an invite.
async function inviteCandidatesForDeal(dealId) {
  await ensureDealContactsTable();
  const [deal] = await sql`
    SELECT d.company_id, c.name AS company_name
      FROM deals d LEFT JOIN companies c ON c.id = d.company_id
     WHERE d.id = ${dealId}
  `;
  const companyId = deal?.company_id || null;

  const [contactRows, signerRows, memberRows, inviteRows] = await Promise.all([
    sql`
      SELECT c.id, c.name, c.email, 'primary' AS role
        FROM deals d JOIN contacts c ON c.id = d.primary_contact_id
       WHERE d.id = ${dealId} AND c.email IS NOT NULL
      UNION
      SELECT c.id, c.name, c.email, COALESCE(dc.role, 'secondary') AS role
        FROM deal_contacts dc JOIN contacts c ON c.id = dc.contact_id
       WHERE dc.deal_id = ${dealId} AND c.email IS NOT NULL
    `,
    sql`
      SELECT s.name, s.email FROM proposals p JOIN signatures s ON s.proposal_id = p.id
       WHERE p.deal_id = ${dealId} AND s.email IS NOT NULL
       ORDER BY s.signed_at DESC LIMIT 1
    `,
    companyId ? sql`
      SELECT pu.email FROM portal_memberships m JOIN portal_users pu ON pu.id = m.portal_user_id
       WHERE m.company_id = ${companyId} AND m.disabled_at IS NULL AND pu.disabled_at IS NULL
    ` : [],
    companyId ? sql`
      SELECT email FROM portal_invites
       WHERE company_id = ${companyId} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
    ` : [],
  ]);

  const members = new Set(memberRows.map((r) => String(r.email).toLowerCase()));
  const pending = new Set(inviteRows.map((r) => String(r.email).toLowerCase()));

  const byEmail = new Map();
  const add = (email, name, source) => {
    const key = String(email || '').trim().toLowerCase();
    if (!key) return;
    if (byEmail.has(key)) return; // first source wins (contacts before signer)
    byEmail.set(key, {
      email: key,
      name: name || null,
      source,
      hasAccess: members.has(key),
      invitePending: pending.has(key),
    });
  };
  for (const c of contactRows) add(c.email, c.name, c.role === 'primary' ? 'Primary contact' : 'Deal contact');
  if (signerRows[0]) add(signerRows[0].email, signerRows[0].name, 'Signed the proposal');

  return {
    companyId,
    companyName: deal?.company_name || null,
    candidates: Array.from(byEmail.values()),
  };
}

// One person's portal profile, for the Client-portal card on a contact page:
// their account, which organisations they can see, pending invites, and a
// recent-activity feed stitched from everything the portal records them doing.
async function portalProfileForEmail(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return { account: null };

  const [pu] = await sql`
    SELECT id, email, name, phone, job_title, last_login_at, disabled_at, created_at
      FROM portal_users WHERE email = ${clean}
  `;

  // Pending invites exist even without an account (that's the whole point).
  const invites = await sql`
    SELECT i.id, i.company_id, i.expires_at, i.created_at, i.invited_by, c.name AS company_name
      FROM portal_invites i JOIN companies c ON c.id = i.company_id
     WHERE i.email = ${clean} AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()
     ORDER BY i.created_at DESC
  `;

  if (!pu) {
    return {
      account: null,
      invites: invites.map((i) => ({
        id: i.id, companyId: i.company_id, companyName: i.company_name,
        expiresAt: i.expires_at, createdAt: i.created_at, invitedBy: i.invited_by || null,
      })),
      memberships: [],
      activity: [],
    };
  }

  const [memberships, brandFiles, dealFiles, extras, quotes] = await Promise.all([
    sql`
      SELECT m.company_id, m.disabled_at, m.created_at, c.name AS company_name
        FROM portal_memberships m JOIN companies c ON c.id = m.company_id
       WHERE m.portal_user_id = ${pu.id}
       ORDER BY m.created_at ASC
    `,
    sql`
      SELECT filename, created_at FROM portal_company_files
       WHERE uploaded_by_portal_user = ${pu.id} ORDER BY created_at DESC LIMIT 20
    `,
    sql`
      SELECT f.filename, f.created_at, f.deal_id, d.title AS deal_title
        FROM deal_files f LEFT JOIN deals d ON d.id = f.deal_id
       WHERE f.portal_user_id = ${pu.id} ORDER BY f.created_at DESC LIMIT 20
    `,
    sql`
      SELECT e.description, e.amount, e.created_at, e.deal_id, d.title AS deal_title
        FROM deal_extras e LEFT JOIN deals d ON d.id = e.deal_id
       WHERE e.portal_user_id = ${pu.id} ORDER BY e.created_at DESC LIMIT 20
    `,
    sql`
      SELECT id, created_at, status FROM quote_requests
       WHERE portal_user_id = ${pu.id} ORDER BY created_at DESC LIMIT 20
    `,
  ]);

  const activity = [
    ...brandFiles.map((f) => ({
      type: 'file', at: f.created_at,
      text: `Uploaded ${f.filename} to brand & documents`, link: null,
    })),
    ...dealFiles.map((f) => ({
      type: 'file', at: f.created_at,
      text: `Uploaded ${f.filename}${f.deal_title ? ` to ${f.deal_title}` : ''}`,
      link: f.deal_id ? `#/deal/${f.deal_id}` : null,
    })),
    ...extras.map((e) => ({
      type: 'extra', at: e.created_at,
      text: `Added an extra: ${e.description} (£${Number(e.amount || 0).toFixed(2)} ex VAT)`,
      link: e.deal_id ? `#/deal/${e.deal_id}` : null,
    })),
    ...quotes.map((q) => ({
      type: 'quote', at: q.created_at,
      text: `Requested a new video (10% portal discount)${q.status === 'qualified' ? ' — qualified' : ''}`,
      link: '#/quote-requests',
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 15);

  return {
    account: {
      id: pu.id,
      email: pu.email,
      name: pu.name || null,
      jobTitle: pu.job_title || null,
      lastLoginAt: pu.last_login_at || null,
      createdAt: pu.created_at,
      disabled: !!pu.disabled_at,
    },
    memberships: memberships.map((m) => ({
      companyId: m.company_id,
      companyName: m.company_name,
      disabled: !!m.disabled_at,
      joinedAt: m.created_at,
    })),
    invites: invites.map((i) => ({
      id: i.id, companyId: i.company_id, companyName: i.company_name,
      expiresAt: i.expires_at, createdAt: i.created_at, invitedBy: i.invited_by || null,
    })),
    activity,
  };
}

// "Preview as client" — mint a short-lived preview token for an organisation and
// hand back the portal URL to open. The token lives in the opened tab only
// (never a cookie), so it can't disturb a real client login.
//
// `manage: true` mints the write-capable variant ("manage mode"): staff work
// inside the client's portal for real — uploading past videos to their library,
// inviting their team, filing documents. That needs a portal-admin permission;
// a read-only look needs only portal.preview, which the production team has.
//
// This is also what a SHARED preview link resolves against: /portal?previewOf=id
// carries no credential of its own, so the recipient's own CRM session and role
// decide whether they get a session at all.
async function previewOp(req, res) {
  const body = req.body || {};
  const manage = body.manage === true;
  const user = await requirePermission(req, res, portalPreviewPerms(manage));
  if (!user) return;
  const companyId = trimOrNull(body.companyId);
  if (!companyId) return res.status(400).json({ error: 'companyId required' });
  const [co] = await sql`SELECT id, name FROM companies WHERE id = ${companyId}`;
  if (!co) return res.status(404).json({ error: 'Company not found' });
  const token = await signPortalPreviewToken({ companyId, staffEmail: user.email, manage });
  return res.status(200).json({
    url: `${PORTAL_URL}?preview=${encodeURIComponent(token)}`,
    // The link to SHARE: no token in it, so it's only useful to someone who is
    // themselves signed in to the CRM with the right role.
    shareUrl: `${PORTAL_URL}?previewOf=${encodeURIComponent(companyId)}`,
    companyName: co.name,
    manage,
  });
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Renders the exact automated invite email, so "what does the client actually
  // receive?" is answerable by looking rather than by asking. Opened as a normal
  // tab, hence HTML rather than JSON. The link is a dummy — nothing is sent and
  // no invite is created.
  if (req.method === 'GET' && trimOrNull(req.query.op) === 'invite-preview') {
    const user = await requirePermission(req, res, portalPreviewPerms(false));
    if (!user) return;
    const companyId = trimOrNull(req.query.companyId);
    const [co] = companyId ? await sql`SELECT name FROM companies WHERE id = ${companyId}` : [];
    const html = portalTeamInviteHtml({
      inviterName: user.name || 'A colleague',
      companyName: co?.name || 'your team',
      inviteUrl: `${PORTAL_URL}?invite=EXAMPLE-TOKEN-THIS-IS-A-PREVIEW`,
      logoUrl: companyId ? await emailLogoUrl(companyId) : null,
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Inert: it's an email body rendered on our own origin.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    return res.status(200).end(html);
  }

  // The read-only portal preview is open to the wider production team (anyone
  // with portal.preview — producers and project managers included), so it
  // authorises itself before the narrower admin gate below. Manage mode still
  // needs a PORTAL_ADMIN_PERM.
  if (req.method === 'POST' && trimOrNull(req.query.op) === 'preview') {
    return previewOp(req, res);
  }

  const user = await requirePermission(req, res, PORTAL_ADMIN_PERMS);
  if (!user) return;
  await ensurePortalTables();

  try {
    if (req.method === 'GET') {
      const companyId = trimOrNull(req.query.companyId);
      const dealId = trimOrNull(req.query.dealId);
      const contactId = trimOrNull(req.query.contactId);

      // Portal profile for a contact (the Client-portal card on a contact page).
      if (contactId) {
        const [ct] = await sql`SELECT id, email, name FROM contacts WHERE id = ${contactId}`;
        if (!ct) return res.status(404).json({ error: 'Contact not found' });
        // Which of the contact's organisations they could be invited to — and,
        // for the card's "open their portal" buttons, whose portal to open.
        // Returned even without an email: they still belong to an organisation.
        const companies = (await sql`
          SELECT c.id, c.name FROM companies c
           WHERE c.id = (SELECT company_id FROM contacts WHERE id = ${contactId})
              OR c.id IN (SELECT company_id FROM contact_companies WHERE contact_id = ${contactId})
        `.catch(() => [])).map((c) => ({ id: c.id, name: c.name }));
        if (!ct.email) {
          return res.status(200).json({
            contactId, noEmail: true, account: null,
            invites: [], memberships: [], activity: [], companies,
          });
        }
        const profile = await portalProfileForEmail(ct.email);
        return res.status(200).json({
          contactId, email: ct.email, ...profile, companies,
        });
      }

      if (companyId) {
        const members = await sql`
          SELECT pu.id, pu.email, pu.name, pu.job_title, pu.last_login_at, pu.disabled_at,
                 m.created_at AS member_since, m.disabled_at AS membership_disabled_at, m.invited_by
            FROM portal_memberships m
            JOIN portal_users pu ON pu.id = m.portal_user_id
           WHERE m.company_id = ${companyId}
           ORDER BY m.created_at ASC
        `;
        const invites = await sql`
          SELECT id, email, invited_by, expires_at, accepted_at, revoked_at, created_at
            FROM portal_invites
           WHERE company_id = ${companyId} AND accepted_at IS NULL AND revoked_at IS NULL
           ORDER BY created_at DESC
        `;
        // Per-deal step progress across the org's live projects + the merged
        // activity timeline (member logins + client actions). Best-effort.
        // brandFiles: the org's uploaded logo/brand guidelines & documents —
        // there's no other staff-side view of these (they live in a private blob).
        const [steps, activity, brandFiles] = await Promise.all([
          companyStepsSummary(companyId).catch(() => []),
          portalTimeline({ companyId }).catch(() => []),
          sql`
            SELECT f.id, f.filename, f.category, f.mime_type, f.size_bytes, f.created_at,
                   COALESCE(pu.name, f.uploaded_by_staff) AS uploaded_by
              FROM portal_company_files f
              LEFT JOIN portal_users pu ON pu.id = f.uploaded_by_portal_user
             WHERE f.company_id = ${companyId}
             ORDER BY f.created_at DESC`.catch(() => []),
        ]);
        return res.status(200).json({
          steps,
          activity,
          brandFiles: brandFiles.map((f) => ({
            id: f.id,
            filename: f.filename,
            category: f.category || 'document',
            sizeBytes: f.size_bytes == null ? null : Number(f.size_bytes),
            createdAt: f.created_at,
            uploadedBy: f.uploaded_by || null,
          })),
          members: members.map((m) => ({
            id: m.id,
            email: m.email,
            name: m.name || null,
            jobTitle: m.job_title || null,
            lastLoginAt: m.last_login_at || null,
            joinedAt: m.member_since,
            invitedBy: m.invited_by || null,
            disabled: !!m.membership_disabled_at || !!m.disabled_at,
          })),
          invites: invites.map((i) => ({
            id: i.id,
            email: i.email,
            invitedBy: i.invited_by || null,
            expiresAt: i.expires_at,
            expired: new Date(i.expires_at) < new Date(),
            createdAt: i.created_at,
          })),
        });
      }

      if (dealId) {
        const [deal] = await sql`
          SELECT id, title, stage, production_phase, portal_extras_discount, final_release_override_at
            FROM deals WHERE id = ${dealId}
        `;
        if (!deal) return res.status(404).json({ error: 'Deal not found' });
        // The final-delivery banner only makes sense once there's actually a final
        // video in play (a cut that's reached sign-off / final invoice / delivered).
        // On a lead with nothing in production there's nothing to release or gate,
        // so we omit finalRelease entirely rather than defaulting it "released".
        const [{ n: finalVideoCount }] = await sql`
          SELECT COUNT(*)::int AS n FROM project_videos
           WHERE deal_id = ${dealId} AND production_stage IN ('signed_off', 'final_invoice', 'delivered')`;
        const finalReleaseUnlocked = finalVideoCount ? await isFinalReleaseUnlocked(dealId).catch(() => false) : false;
        const offers = await sql`
          SELECT id, kind, proposal_extra_id, title, description, amount, hidden, created_by, created_at
            FROM portal_extra_offers WHERE deal_id = ${dealId} ORDER BY created_at ASC
        `;
        // What the client currently sees, for a live preview in the panel.
        const derived = await computePortalOffers(deal);
        // Steps completed + activity timeline (logins + client actions) for this
        // deal. Best-effort so the card still renders if either query hiccups.
        const [steps, activity] = await Promise.all([
          dealSteps(dealId).catch(() => []),
          portalTimeline({ dealId }).catch(() => []),
        ]);
        return res.status(200).json({
          dealId,
          steps,
          activity,
          finalRelease: finalVideoCount ? { override: !!deal.final_release_override_at, unlocked: finalReleaseUnlocked } : null,
          ...(await inviteCandidatesForDeal(dealId)),
          discount: Number(deal.portal_extras_discount ?? 0.10),
          offers: offers.map((o) => ({
            id: o.id,
            kind: o.kind,
            proposalExtraId: o.proposal_extra_id || null,
            title: o.title || null,
            description: o.description || null,
            amount: o.amount == null ? null : Number(o.amount),
            hidden: !!o.hidden,
            createdBy: o.created_by || null,
          })),
          derived,
        });
      }

      return res.status(400).json({ error: 'companyId or dealId required' });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const op = trimOrNull(req.query.op);
    const body = req.body || {};

    if (op === 'invite') {
      const companyId = trimOrNull(body.companyId);
      const email = lowerOrNull(body.email);
      if (!companyId || !email) return res.status(400).json({ error: 'companyId and email required' });
      const [co] = await sql`SELECT name FROM companies WHERE id = ${companyId}`;
      if (!co) return res.status(404).json({ error: 'Company not found' });

      // compose: mint the invite and hand the link back so the CRM can open a
      // real, editable email in the composer — no automatic send. The invite
      // row exists either way, so a link sent by hand behaves exactly like one
      // sent by the system (same expiry, same "resend" re-keying).
      if (body.compose === true) {
        const { rawToken } = await createPortalInvite({
          email,
          companyId,
          prefill: { name: trimOrNull(body.name) },
          invitedBy: user.email,
        });
        return res.status(201).json({
          ok: true,
          inviteUrl: inviteUrlFor(rawToken),
          email,
          companyName: co.name,
          expiresInDays: INVITE_DAYS,
        });
      }

      await sendTeamInvite({
        email,
        companyId,
        companyName: co.name,
        inviterName: user.name || 'The Squideo team',
        invitedBy: user.email,
        prefill: { name: trimOrNull(body.name) },
      });
      return res.status(201).json({ ok: true });
    }

    if (op === 'resend-invite') {
      const inviteId = trimOrNull(body.inviteId);
      const [inv] = await sql`
        SELECT i.email, i.company_id, i.prefill, c.name AS company_name
          FROM portal_invites i JOIN companies c ON c.id = i.company_id
         WHERE i.id = ${inviteId}
      `;
      if (!inv) return res.status(404).json({ error: 'Invite not found' });
      const { rawToken } = await createPortalInvite({
        email: inv.email, companyId: inv.company_id, prefill: inv.prefill, invitedBy: user.email,
      });
      await sendMail({
        to: inv.email,
        subject: `Your invite to ${inv.company_name}'s Squideo portal`,
        html: portalTeamInviteHtml({
          inviterName: user.name || 'The Squideo team',
          companyName: inv.company_name,
          inviteUrl: inviteUrlFor(rawToken),
          logoUrl: await emailLogoUrl(inv.company_id),
        }),
        text: `Join ${inv.company_name}'s Squideo Client Portal: ${inviteUrlFor(rawToken)}`,
        throwOnError: true,
      });
      return res.status(200).json({ ok: true });
    }

    if (op === 'revoke-invite') {
      const inviteId = trimOrNull(body.inviteId);
      await sql`UPDATE portal_invites SET revoked_at = NOW() WHERE id = ${inviteId} AND accepted_at IS NULL`;
      return res.status(200).json({ ok: true });
    }

    if (op === 'disable-member' || op === 'enable-member') {
      const portalUserId = trimOrNull(body.portalUserId);
      const companyId = trimOrNull(body.companyId);
      if (!portalUserId || !companyId) return res.status(400).json({ error: 'portalUserId and companyId required' });
      if (op === 'disable-member') {
        await sql`
          UPDATE portal_memberships SET disabled_at = NOW()
           WHERE portal_user_id = ${portalUserId} AND company_id = ${companyId}
        `;
        // Bump token_version so any live session re-authenticates immediately
        // (memberships are re-read per request, but this is belt-and-braces).
        await sql`UPDATE portal_users SET token_version = token_version + 1 WHERE id = ${portalUserId}`;
      } else {
        await sql`
          UPDATE portal_memberships SET disabled_at = NULL
           WHERE portal_user_id = ${portalUserId} AND company_id = ${companyId}
        `;
      }
      return res.status(200).json({ ok: true });
    }

    // Invite one or more people to the deal's organisation portal. Recipients
    // come from the modal: the deal's contacts/signer (pre-ticked) plus any
    // ad-hoc emails typed in, each optionally saved as a CRM contact on the
    // deal. Creates the company from the proposal if the deal somehow has none
    // (the org is the portal's anchor).
    if (op === 'invite-deal') {
      const dealId = trimOrNull(body.dealId);
      const recipients = Array.isArray(body.recipients) ? body.recipients : [];
      if (!dealId) return res.status(400).json({ error: 'dealId required' });
      if (!recipients.length) return res.status(400).json({ error: 'Pick at least one person to invite' });

      // Staff-initiated invites never invent an organisation — the org is what
      // the invitee will see projects for, so it must be a deliberate link.
      // (The automatic post-signing invite does create one, from the proposal.)
      const [dealRow] = await sql`
        SELECT d.company_id, c.name AS company_name
          FROM deals d LEFT JOIN companies c ON c.id = d.company_id
         WHERE d.id = ${dealId}
      `;
      if (!dealRow) return res.status(404).json({ error: 'Deal not found' });
      if (!dealRow.company_id) {
        return res.status(400).json({ error: 'This deal has no company — link it to a company first, then invite.' });
      }
      const org = { companyId: dealRow.company_id, companyName: dealRow.company_name };

      await ensureDealContactsTable();
      const sent = [];
      const failed = [];
      for (const r of recipients) {
        const email = lowerOrNull(r?.email);
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          failed.push({ email: r?.email || '(blank)', reason: 'Not a valid email' });
          continue;
        }
        const name = trimOrNull(r?.name);
        try {
          // Optionally save an ad-hoc invitee as a CRM contact, attached to the
          // company and linked to this deal as a secondary contact.
          if (r?.createContact) {
            const [existing] = await sql`SELECT id FROM contacts WHERE LOWER(email) = ${email} LIMIT 1`;
            let contactId = existing?.id || null;
            if (!contactId) {
              contactId = makeId('ct');
              await sql`
                INSERT INTO contacts (id, email, name, company_id, provisional, source)
                VALUES (${contactId}, ${email}, ${name}, ${org.companyId}, FALSE, 'portal_invite')
              `;
            }
            await sql`
              INSERT INTO deal_contacts (deal_id, contact_id, role, added_by)
              VALUES (${dealId}, ${contactId}, 'secondary', ${user.email})
              ON CONFLICT (deal_id, contact_id) DO NOTHING
            `;
          }
          await sendTeamInvite({
            email,
            companyId: org.companyId,
            companyName: org.companyName,
            inviterName: user.name || 'The Squideo team',
            invitedBy: user.email,
            prefill: { name },
          });
          sent.push(email);
        } catch (err) {
          console.error('[portal-admin] invite-deal send failed', email, err.message);
          failed.push({ email, reason: err.message || 'Send failed' });
        }
      }
      if (!sent.length) {
        return res.status(502).json({ error: `Could not send: ${failed[0]?.reason || 'unknown error'}` });
      }
      return res.status(200).json({ ok: true, sent, failed });
    }

    // Generate a per-client portal link for a deal, for the PM to drop into an
    // intro email they write in the composer. The invite link handles both
    // sign-up and login, and links the new portal account back to the CRM
    // contact by email. Returns the URL only — no email is sent here.
    if (op === 'portal-link') {
      const dealId = trimOrNull(body.dealId);
      const email = lowerOrNull(body.email);
      if (!dealId || !email) return res.status(400).json({ error: 'dealId and recipient email required' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Add the client’s email first' });

      const [deal] = await sql`
        SELECT d.id, d.title, d.company_id, d.producer_email, c.name AS company_name
          FROM deals d LEFT JOIN companies c ON c.id = d.company_id
         WHERE d.id = ${dealId}
      `;
      if (!deal) return res.status(404).json({ error: 'Deal not found' });
      if (!deal.company_id) return res.status(400).json({ error: 'This deal has no company — link it to a company first.' });

      // The intro email unlocks the client's kick-off task, which offers the
      // assigned team's availability — so refuse to launch it until the deal has
      // a team (mirrors the disabled button; a stale client can't bypass it).
      if (body.markIntro) {
        const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM deal_assignees WHERE deal_id = ${dealId}`
          .catch(() => [{ n: 0 }]);
        const hasTeam = n > 0 || !!deal.producer_email;
        if (!hasTeam) {
          return res.status(400).json({ error: 'Assign a team member to this deal before sending the intro email — they host the client’s kick-off call.' });
        }
      }

      // Prefill from the CRM contact so signup is one click.
      const [contact] = await sql`SELECT name, phone, title FROM contacts WHERE LOWER(email) = ${email} ORDER BY created_at ASC LIMIT 1`;
      const prefill = { name: trimOrNull(body.name) || contact?.name || null, phone: contact?.phone || null, jobTitle: contact?.title || null };

      const { rawToken } = await createPortalInvite({ email, companyId: deal.company_id, prefill, invitedBy: user.email });

      // When this link is generated for the "Send intro email" action, that's the
      // trigger that unlocks the client's portal task list (voiceover, kick-off,
      // PO). Stamp it once; a generic "insert portal link" in the composer passes
      // no flag and leaves it untouched.
      if (body.markIntro) {
        await ensureProductionSchema();
        await sql`
          UPDATE deals SET client_tasks_launched_at = COALESCE(client_tasks_launched_at, NOW())
           WHERE id = ${dealId}
        `.catch(() => {});

        // Tell the client their tasks are live: an in-portal feed row (for any
        // teammates already on the portal) + a branded task email. Best-effort —
        // never let notification failure break link generation.
        try {
          const ctx = await computeDealTasks(dealId);
          const openCount = ctx?.openCount || 0;
          await notifyPortalUser({
            companyId: deal.company_id,
            dealId,
            key: 'portal.tasks_launched',
            title: 'Your project is ready',
            body: openCount
              ? `You have ${openCount} task${openCount === 1 ? '' : 's'} to complete to get started.`
              : 'Track your project and share what we need in the portal.',
            link: `#/project/${dealId}`,
          });

          // The branded task email only sends when the team has authored the
          // task-email copy (settings.project_tasks_email) — an explicit opt-in
          // so clients don't also get the PM's Gmail-composer intro note twice.
          const [s] = await sql`SELECT project_tasks_email FROM settings WHERE id = 1`.catch(() => [null]);
          const tpl = s?.project_tasks_email || null;
          if (tpl && (tpl.subject || tpl.bodyHtml)) {
            await sendMail({
              to: email,
              subject: tpl.subject || `${deal.title} — a couple of things to get started`,
              html: portalProjectTasksHtml({
                bodyHtml: tpl.bodyHtml,
                inviteUrl: inviteUrlFor(rawToken),
                logoUrl: await emailLogoUrl(deal.company_id),
              }),
              text: `Your project is underway. Open your portal: ${inviteUrlFor(rawToken)}`,
            });
          }
        } catch (err) {
          console.warn('[portal-admin] task-launch notify failed', err.message);
        }
      }

      return res.status(200).json({ url: inviteUrlFor(rawToken), companyName: deal.company_name || null });
    }

    // Account-level controls from a contact's portal card. Disabling kills every
    // session immediately (token_version bump) and blocks login everywhere, as
    // opposed to disable-member which only removes one organisation.
    if (op === 'user-disable' || op === 'user-enable' || op === 'user-signout' || op === 'user-reset-link') {
      const portalUserId = trimOrNull(body.portalUserId);
      if (!portalUserId) return res.status(400).json({ error: 'portalUserId required' });
      const [pu] = await sql`SELECT id, email, name FROM portal_users WHERE id = ${portalUserId}`;
      if (!pu) return res.status(404).json({ error: 'Portal account not found' });

      if (op === 'user-disable') {
        await sql`
          UPDATE portal_users SET disabled_at = NOW(), token_version = token_version + 1
           WHERE id = ${portalUserId}
        `;
        return res.status(200).json({ ok: true });
      }
      if (op === 'user-enable') {
        await sql`UPDATE portal_users SET disabled_at = NULL WHERE id = ${portalUserId}`;
        return res.status(200).json({ ok: true });
      }
      if (op === 'user-signout') {
        await sql`UPDATE portal_users SET token_version = token_version + 1 WHERE id = ${portalUserId}`;
        return res.status(200).json({ ok: true });
      }

      // user-reset-link: same single-use hashed token the portal's own
      // "forgotten password" flow issues (60 min), emailed to the client.
      const raw = createRawToken();
      await sql`
        INSERT INTO portal_login_tokens (id, portal_user_id, token_hash, purpose, expires_at)
        VALUES (${makeId('plt')}, ${portalUserId}, ${hashToken(raw)}, 'password_reset',
                ${new Date(Date.now() + 60 * 60 * 1000).toISOString()})
      `;
      const resetUrl = `${PORTAL_URL}?reset=${encodeURIComponent(raw)}`;
      const [membership] = await sql`
        SELECT company_id FROM portal_memberships
         WHERE portal_user_id = ${portalUserId} AND disabled_at IS NULL
         ORDER BY created_at ASC LIMIT 1
      `;
      await sendMail({
        to: pu.email,
        subject: 'Reset your Squideo portal password',
        html: portalResetHtml({ resetUrl, logoUrl: await emailLogoUrl(membership?.company_id) }),
        text: `Choose a new Squideo Client Portal password (link works once, expires in 60 minutes): ${resetUrl}`,
        throwOnError: true,
      });
      return res.status(200).json({ ok: true, email: pu.email });
    }

    // Resolve a short-lived download URL for a client-uploaded brand/document
    // file (private blob). Mirrors the staff deal-file download in deals.js.
    if (op === 'brand-file-url') {
      const id = trimOrNull(body.id);
      if (!id) return res.status(400).json({ error: 'id required' });
      const [f] = await sql`SELECT blob_url, filename FROM portal_company_files WHERE id = ${id}`;
      if (!f || !f.blob_url) return res.status(404).json({ error: 'File not found' });
      const downloadUrl = await getDownloadUrl(f.blob_url);
      return res.status(200).json({ downloadUrl, filename: f.filename });
    }

    if (op === 'offer-create') {
      const dealId = trimOrNull(body.dealId);
      if (!dealId) return res.status(400).json({ error: 'dealId required' });
      const kind = body.kind === 'override' ? 'override' : 'custom';
      const amount = numberOrNull(body.amount);
      if (kind === 'custom') {
        if (!trimOrNull(body.title)) return res.status(400).json({ error: 'title required' });
        if (amount == null || amount <= 0) return res.status(400).json({ error: 'A positive amount is required' });
      } else if (!trimOrNull(body.proposalExtraId)) {
        return res.status(400).json({ error: 'proposalExtraId required for an override' });
      }
      const id = makeId('pxo');
      await sql`
        INSERT INTO portal_extra_offers (id, deal_id, kind, proposal_extra_id, title, description, amount, hidden, created_by)
        VALUES (${id}, ${dealId}, ${kind}, ${trimOrNull(body.proposalExtraId)}, ${trimOrNull(body.title)},
                ${trimOrNull(body.description)}, ${amount}, ${body.hidden === true}, ${user.email})
      `;
      return res.status(201).json({ ok: true, id });
    }

    if (op === 'offer-update') {
      const id = trimOrNull(body.id);
      const [cur] = await sql`SELECT * FROM portal_extra_offers WHERE id = ${id}`;
      if (!cur) return res.status(404).json({ error: 'Offer not found' });
      const title = 'title' in body ? trimOrNull(body.title) : cur.title;
      const description = 'description' in body ? trimOrNull(body.description) : cur.description;
      const amount = 'amount' in body ? numberOrNull(body.amount) : cur.amount;
      const hidden = 'hidden' in body ? body.hidden === true : cur.hidden;
      await sql`
        UPDATE portal_extra_offers
           SET title = ${title}, description = ${description}, amount = ${amount},
               hidden = ${hidden}, updated_at = NOW()
         WHERE id = ${id}
      `;
      return res.status(200).json({ ok: true });
    }

    if (op === 'offer-delete') {
      await sql`DELETE FROM portal_extra_offers WHERE id = ${trimOrNull(body.id)}`;
      return res.status(200).json({ ok: true });
    }

    if (op === 'set-discount') {
      const dealId = trimOrNull(body.dealId);
      const discount = numberOrNull(body.discount);
      if (!dealId || discount == null || discount < 0 || discount > 1) {
        return res.status(400).json({ error: 'discount must be a fraction between 0 and 1' });
      }
      await sql`UPDATE deals SET portal_extras_discount = ${discount}, updated_at = NOW() WHERE id = ${dealId}`;
      return res.status(200).json({ ok: true });
    }

    // Where the script stands, as the client's portal reports it:
    //   'received' — they sent it by email (often pre-close), so stop asking
    //   'refining' — they gave us a draft and we're polishing it
    //   'squideo'  — they've asked us to write it from scratch
    //   null       — still waiting
    // Mutually exclusive; a producer sets it from the deal page after a call.
    if (op === 'set-script-status') {
      const dealId = trimOrNull(body.dealId);
      if (!dealId) return res.status(400).json({ error: 'dealId required' });
      const raw = trimOrNull(body.status);
      const status = ['received', 'refining', 'squideo'].includes(raw) ? raw : null;
      await sql`
        UPDATE deals
           SET script_status = ${status},
               script_status_at = ${status ? new Date().toISOString() : null},
               script_status_by = ${status ? (user.email || null) : null},
               updated_at = NOW()
         WHERE id = ${dealId}
      `;
      return res.status(200).json({ ok: true, status });
    }

    return res.status(400).json({ error: 'Unknown op' });
  } catch (err) {
    console.error('[portal-admin] error', err);
    return res.status(500).json({ error: 'Request failed' });
  }
}
