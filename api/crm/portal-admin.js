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

import sql from '../_lib/db.js';
import { cors, requirePermission } from '../_lib/middleware.js';
import { makeId, trimOrNull, lowerOrNull, numberOrNull, ensureDealContactsTable } from '../_lib/crm/shared.js';
import { sendMail } from '../_lib/email.js';
import { ensurePortalTables } from '../_lib/portal/db.js';
import { sendTeamInvite, createPortalInvite, inviteUrlFor, resolveCompanyForDeal } from '../_lib/portal/onboarding.js';
import { portalTeamInviteHtml } from '../_lib/portal/emails.js';
import { computePortalOffers } from '../_lib/portal/extrasOffers.js';

// Any of these grants access — the panel spans company pages (members) and
// deal pages (offers/pricing), which different roles legitimately manage.
const PORTAL_ADMIN_PERMS = ['companies.manage_all', 'deals.manage_all', 'invoices.manage', 'users.manage'];

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

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requirePermission(req, res, PORTAL_ADMIN_PERMS);
  if (!user) return;
  await ensurePortalTables();

  try {
    if (req.method === 'GET') {
      const companyId = trimOrNull(req.query.companyId);
      const dealId = trimOrNull(req.query.dealId);

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
        return res.status(200).json({
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
          SELECT id, title, stage, production_phase, portal_extras_discount
            FROM deals WHERE id = ${dealId}
        `;
        if (!deal) return res.status(404).json({ error: 'Deal not found' });
        const offers = await sql`
          SELECT id, kind, proposal_extra_id, title, description, amount, hidden, created_by, created_at
            FROM portal_extra_offers WHERE deal_id = ${dealId} ORDER BY created_at ASC
        `;
        // What the client currently sees, for a live preview in the panel.
        const derived = await computePortalOffers(deal);
        return res.status(200).json({
          dealId,
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
        html: portalTeamInviteHtml({ inviterName: user.name || 'The Squideo team', companyName: inv.company_name, inviteUrl: inviteUrlFor(rawToken) }),
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

      const [prop] = await sql`
        SELECT data FROM proposals WHERE deal_id = ${dealId} ORDER BY created_at DESC LIMIT 1
      `;
      const org = await resolveCompanyForDeal(dealId, prop?.data || null, recipients[0]?.email || null);
      if (!org?.companyId) {
        return res.status(400).json({ error: 'This deal has no company — link it to a company first, then invite.' });
      }

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

    return res.status(400).json({ error: 'Unknown op' });
  } catch (err) {
    console.error('[portal-admin] error', err);
    return res.status(500).json({ error: 'Request failed' });
  }
}
