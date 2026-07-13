import sql from '../db.js';
import { makeId, trimOrNull, lowerOrNull, ensureDealContactsTable, ensureContactCompanies } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { ensurePortalTables } from '../portal/db.js';

// Re-read a contact with its full set of organisation ids (the join table is a
// superset that already includes the primary company_id after backfill).
async function loadContactRow(id) {
  const rows = await sql`
    SELECT id, email, name, phone, title, company_id, notes, provisional, source, created_at, updated_at,
           COALESCE((SELECT array_agg(cc.company_id) FROM contact_companies cc WHERE cc.contact_id = contacts.id), '{}') AS company_ids
    FROM contacts WHERE id = ${id}
  `;
  return rows[0] ? serialiseContact(rows[0]) : null;
}

export async function contactsRoute(req, res, id, action, user, subaction = null) {
  if (!id) {
    if (req.method === 'GET') {
      // Count linked deals per contact — both where they're the primary contact
      // and where they're a secondary contact (deal_contacts) — so the UI can
      // show "N deals" and warn before deleting. Ensure deal_contacts exists
      // first (lazily created) so the correlated subquery can't 500.
      await ensureDealContactsTable().catch(() => {});
      await ensureContactCompanies();
      // Portal status is matched by email — the customer portal has its own
      // identities (portal_users), deliberately not FK'd to contacts.
      await ensurePortalTables().catch(() => {});
      const rows = await sql`
        SELECT id, email, name, phone, title, company_id, notes, provisional, source, created_at, updated_at,
               (SELECT COUNT(DISTINCT d.id)::int FROM deals d
                  WHERE d.primary_contact_id = contacts.id
                     OR EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.contact_id = contacts.id AND dc.deal_id = d.id)
               ) AS deal_count,
               COALESCE((SELECT array_agg(cc.company_id) FROM contact_companies cc WHERE cc.contact_id = contacts.id), '{}') AS company_ids,
               (SELECT CASE WHEN pu.disabled_at IS NULL THEN 'active' ELSE 'disabled' END
                  FROM portal_users pu WHERE LOWER(pu.email) = LOWER(contacts.email) LIMIT 1
               ) AS portal_status,
               EXISTS (SELECT 1 FROM portal_invites i
                        WHERE LOWER(i.email) = LOWER(contacts.email)
                          AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()
               ) AS portal_invite_pending
        FROM contacts
        WHERE provisional = FALSE
        ORDER BY name ASC NULLS LAST, email ASC
      `;
      return res.status(200).json(rows.map(serialiseContact));
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const newId = body.id || makeId('ct');
      const companyId = trimOrNull(body.companyId) || null;
      await sql`
        INSERT INTO contacts (id, email, name, phone, title, company_id, notes)
        VALUES (
          ${newId},
          ${lowerOrNull(body.email)},
          ${trimOrNull(body.name)},
          ${trimOrNull(body.phone)},
          ${trimOrNull(body.title)},
          ${companyId},
          ${trimOrNull(body.notes)}
        )
      `;
      // Mirror the primary org into the memberships table so the join stays the
      // complete set of a contact's organisations.
      if (companyId) {
        await ensureContactCompanies();
        await sql`INSERT INTO contact_companies (contact_id, company_id) VALUES (${newId}, ${companyId}) ON CONFLICT DO NOTHING`;
      }
      return res.status(201).json(await loadContactRow(newId));
    }
    return res.status(405).end();
  }

  // /contacts/:id/detail — contact + organisations + deals where they're primary
  if (action === 'detail' && req.method === 'GET') {
    await ensureContactCompanies();
    const [contactRow] = await sql`
      SELECT id, email, name, phone, title, company_id, notes, provisional, source, created_at, updated_at,
             COALESCE((SELECT array_agg(cc.company_id) FROM contact_companies cc WHERE cc.contact_id = contacts.id), '{}') AS company_ids
      FROM contacts WHERE id = ${id}
    `;
    if (!contactRow) return res.status(404).json({ error: 'Not found' });

    const [companyRows, dealRows] = await Promise.all([
      // Every organisation the contact belongs to (primary first), not just one.
      sql`SELECT co.id, co.name, co.domain, co.notes, co.created_at, co.updated_at,
                 (co.id = ${contactRow.company_id}) AS is_primary
            FROM companies co
           WHERE co.id = ${contactRow.company_id}
              OR EXISTS (SELECT 1 FROM contact_companies cc WHERE cc.contact_id = ${id} AND cc.company_id = co.id)
           ORDER BY (co.id = ${contactRow.company_id}) DESC, co.name ASC`,
      sql`
        SELECT d.id, d.title, d.company_id, d.primary_contact_id, d.owner_email,
               d.stage, d.value, d.expected_close_at, d.stage_changed_at,
               d.last_activity_at, d.created_at, d.updated_at,
               (SELECT COUNT(*)::int FROM proposals p WHERE p.deal_id = d.id) AS proposal_count
          FROM deals d
          WHERE d.primary_contact_id = ${id}
          ORDER BY d.stage_changed_at DESC
      `,
    ]);

    const companies = companyRows.map(co => ({
      id: co.id,
      name: co.name,
      domain: co.domain || null,
      notes: co.notes || null,
      isPrimary: !!co.is_primary,
      createdAt: co.created_at,
      updatedAt: co.updated_at,
    }));
    return res.status(200).json({
      ...serialiseContact(contactRow),
      companies,
      // Primary org kept for back-compat with anything still reading `company`.
      company: companies.find(co => co.isPrimary) || companies[0] || null,
      deals: dealRows.map(d => ({
        id: d.id,
        title: d.title,
        companyId: d.company_id || null,
        primaryContactId: d.primary_contact_id || null,
        ownerEmail: d.owner_email || null,
        stage: d.stage,
        value: d.value != null ? Number(d.value) : null,
        expectedCloseAt: d.expected_close_at || null,
        stageChangedAt: d.stage_changed_at,
        lastActivityAt: d.last_activity_at,
        createdAt: d.created_at,
        updatedAt: d.updated_at,
        proposalCount: d.proposal_count || 0,
      })),
    });
  }

  // /contacts/:id/companies — manage which organisations a contact belongs to.
  //   POST   { companyId }                  → add a membership (additive)
  //   DELETE /contacts/:id/companies/:cid   → remove that membership
  // Returns the updated contact (with companyIds) for the optimistic merge.
  if (action === 'companies') {
    await ensureContactCompanies();
    const contact = (await sql`SELECT id, company_id FROM contacts WHERE id = ${id}`)[0];
    if (!contact) return res.status(404).json({ error: 'Not found' });

    if (req.method === 'POST') {
      const companyId = trimOrNull((req.body || {}).companyId);
      if (!companyId) return res.status(400).json({ error: 'companyId required' });
      const company = (await sql`SELECT id FROM companies WHERE id = ${companyId}`)[0];
      if (!company) return res.status(404).json({ error: 'Organisation not found' });
      await sql`INSERT INTO contact_companies (contact_id, company_id) VALUES (${id}, ${companyId}) ON CONFLICT DO NOTHING`;
      // First org a contact gets becomes its primary (so deals/Xero have one).
      if (!contact.company_id) {
        await sql`UPDATE contacts SET company_id = ${companyId}, updated_at = NOW() WHERE id = ${id}`;
      }
      return res.status(200).json(await loadContactRow(id));
    }

    if (req.method === 'DELETE') {
      const companyId = trimOrNull(subaction) || trimOrNull((req.body || {}).companyId);
      if (!companyId) return res.status(400).json({ error: 'companyId required' });
      await sql`DELETE FROM contact_companies WHERE contact_id = ${id} AND company_id = ${companyId}`;
      // If we removed the primary org, repoint the primary to another membership
      // (or null) so contacts.company_id always points at a real membership.
      if (contact.company_id === companyId) {
        const next = (await sql`
          SELECT company_id FROM contact_companies WHERE contact_id = ${id}
          ORDER BY created_at ASC LIMIT 1
        `)[0];
        await sql`UPDATE contacts SET company_id = ${next?.company_id || null}, updated_at = NOW() WHERE id = ${id}`;
      }
      return res.status(200).json(await loadContactRow(id));
    }
    return res.status(405).end();
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    // Read-modify-write keeps the SQL simple — this table is small.
    const cur = (await sql`
      SELECT id, email, name, phone, title, company_id, notes, provisional, source, created_at, updated_at
      FROM contacts WHERE id = ${id}
    `)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const next = {
      email:      'email'     in body ? lowerOrNull(body.email)     : cur.email,
      name:       'name'      in body ? trimOrNull(body.name)       : cur.name,
      phone:      'phone'     in body ? trimOrNull(body.phone)      : cur.phone,
      title:      'title'     in body ? trimOrNull(body.title)      : cur.title,
      company_id: 'companyId' in body ? (trimOrNull(body.companyId) || null) : cur.company_id,
      notes:      'notes'     in body ? trimOrNull(body.notes)      : cur.notes,
    };
    await sql`
      UPDATE contacts
         SET email = ${next.email},
             name = ${next.name},
             phone = ${next.phone},
             title = ${next.title},
             company_id = ${next.company_id},
             notes = ${next.notes},
             updated_at = NOW()
       WHERE id = ${id}
    `;
    // Editing the primary org adds it as a membership too (the join table stays
    // a superset). We don't drop the OLD primary's membership — a contact keeps
    // its other organisations; detach those from the org/contact page instead.
    if ('companyId' in body && next.company_id) {
      await ensureContactCompanies();
      await sql`INSERT INTO contact_companies (contact_id, company_id) VALUES (${id}, ${next.company_id}) ON CONFLICT DO NOTHING`;
    }
    return res.status(200).json(await loadContactRow(id));
  }
  if (req.method === 'DELETE') {
    if (!hasPermission(await getRole(user.role), 'contacts.manage_all')) {
      return res.status(403).json({ error: 'You do not have permission to delete contacts' });
    }
    // Unlink from any deal that has this as its primary contact first. The
    // deals.primary_contact_id FK would otherwise block the delete (or leave a
    // deal pointing at a ghost contact). Other references — deal_contacts,
    // quote_requests, project_retainers — already cascade / set-null on their
    // own FKs, so they need no explicit cleanup here.
    await sql`UPDATE deals SET primary_contact_id = NULL WHERE primary_contact_id = ${id}`;
    await sql`DELETE FROM contacts WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }
  return res.status(405).end();
}

export function serialiseContact(r) {
  return {
    id: r.id,
    email: r.email || null,
    name: r.name || null,
    phone: r.phone || null,
    title: r.title || null,
    companyId: r.company_id || null,
    // All organisations the contact belongs to (primary + memberships). Only on
    // rows that select the aggregate; the primary is always folded in so it's
    // never missing even before the backfill reaches an old row.
    ...('company_ids' in r ? {
      companyIds: (() => {
        const ids = new Set((Array.isArray(r.company_ids) ? r.company_ids : []).filter(Boolean));
        if (r.company_id) ids.add(r.company_id);
        return [...ids];
      })(),
    } : {}),
    notes: r.notes || null,
    provisional: r.provisional === true,
    source: r.source || null,
    // Linked-deal count (list query only) so the UI can warn before deleting.
    dealCount: r.deal_count !== undefined ? Number(r.deal_count) : null,
    // Customer-portal status (list query only): 'active' | 'disabled' | null,
    // plus whether an unaccepted invite is outstanding.
    ...(r.portal_status !== undefined ? {
      portalStatus: r.portal_status || null,
      portalInvitePending: r.portal_invite_pending === true,
    } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
