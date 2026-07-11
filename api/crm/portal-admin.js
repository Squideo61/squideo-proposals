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
import { makeId, trimOrNull, lowerOrNull, numberOrNull } from '../_lib/crm/shared.js';
import { sendMail } from '../_lib/email.js';
import { ensurePortalTables } from '../_lib/portal/db.js';
import { sendPortalWelcome, sendTeamInvite, createPortalInvite, inviteUrlFor } from '../_lib/portal/onboarding.js';
import { portalTeamInviteHtml } from '../_lib/portal/emails.js';
import { computePortalOffers } from '../_lib/portal/extrasOffers.js';

// Any of these grants access — the panel spans company pages (members) and
// deal pages (offers/pricing), which different roles legitimately manage.
const PORTAL_ADMIN_PERMS = ['companies.manage_all', 'deals.manage_all', 'invoices.manage', 'users.manage'];

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

    if (op === 'resend-welcome') {
      const dealId = trimOrNull(body.dealId);
      if (!dealId) return res.status(400).json({ error: 'dealId required' });
      // Prefer the signer of the deal's signed proposal; fall back to the
      // deal's primary contact.
      const [sig] = await sql`
        SELECT s.name, s.email, p.data
          FROM proposals p JOIN signatures s ON s.proposal_id = p.id
         WHERE p.deal_id = ${dealId}
         ORDER BY s.signed_at DESC LIMIT 1
      `;
      let signerName = sig?.name || null;
      let signerEmail = sig?.email || null;
      let proposalData = sig?.data || null;
      if (!signerEmail) {
        const [ct] = await sql`
          SELECT ct.name, ct.email FROM deals d JOIN contacts ct ON ct.id = d.primary_contact_id
           WHERE d.id = ${dealId}
        `;
        signerName = ct?.name || null;
        signerEmail = ct?.email || null;
      }
      if (!signerEmail) return res.status(400).json({ error: 'No signer or primary-contact email on this deal — add a contact with an email first.' });
      const result = await sendPortalWelcome({ dealId, proposalData, signerName, signerEmail });
      if (!result.sent) return res.status(400).json({ error: `Could not send: ${result.reason}` });
      return res.status(200).json({ ok: true, existing: !!result.existing, email: signerEmail });
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
