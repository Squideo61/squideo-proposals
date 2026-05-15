import sql from '../db.js';
import { makeId, trimOrNull, lowerOrNull } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';

export async function companiesRoute(req, res, id, action, user) {
  // POST /companies/from-xero-contact — find or create a local company linked
  // to a given Xero contact ID. Used by the contact picker so deals/proposals
  // always resolve to a local company with a stable xero_contact_id link.
  if (id === 'from-xero-contact' && req.method === 'POST') {
    const body = req.body || {};
    const xeroContactId = trimOrNull(body.xeroContactId);
    if (!xeroContactId) return res.status(400).json({ error: 'xeroContactId required' });

    // Already linked? Return existing.
    const existing = await sql`
      SELECT id, name, domain, notes, xero_contact_id, created_at, updated_at
        FROM companies WHERE xero_contact_id = ${xeroContactId} LIMIT 1
    `;
    if (existing.length) return res.status(200).json(serialiseCompany(existing[0]));

    // Look up the Xero contact in the mirror so we can copy its name.
    const [xc] = await sql`
      SELECT id, name, email, country FROM xero_contacts WHERE id = ${xeroContactId}
    `;
    if (!xc) return res.status(404).json({ error: 'Xero contact not found in mirror — run sync' });

    // Try matching an unlinked local company by name (case-insensitive) first.
    const byName = await sql`
      SELECT id, name, domain, notes, xero_contact_id, created_at, updated_at
        FROM companies
       WHERE xero_contact_id IS NULL
         AND LOWER(name) = LOWER(${xc.name})
       LIMIT 1
    `;
    if (byName.length) {
      await sql`UPDATE companies SET xero_contact_id = ${xeroContactId}, updated_at = NOW() WHERE id = ${byName[0].id}`;
      const refreshed = await sql`
        SELECT id, name, domain, notes, xero_contact_id, created_at, updated_at
          FROM companies WHERE id = ${byName[0].id}
      `;
      return res.status(200).json(serialiseCompany(refreshed[0]));
    }

    // Otherwise, create a fresh local company linked to the Xero contact.
    const newId = makeId('co');
    const domain = xc.email && xc.email.includes('@') ? xc.email.split('@')[1].toLowerCase() : null;
    await sql`
      INSERT INTO companies (id, name, domain, xero_contact_id)
      VALUES (${newId}, ${xc.name}, ${domain}, ${xeroContactId})
    `;
    const rows = await sql`
      SELECT id, name, domain, notes, xero_contact_id, created_at, updated_at
        FROM companies WHERE id = ${newId}
    `;
    return res.status(201).json(serialiseCompany(rows[0]));
  }

  if (!id) {
    if (req.method === 'GET') {
      // EXISTS subquery joins signatures → proposals → deals → companies in
      // one shot, so the Customers view can flag every company that has had a
      // signed proposal land against it without a per-row round-trip.
      const rows = await sql`
        SELECT c.id, c.name, c.domain, c.notes, c.xero_contact_id,
               c.customer_verified_at, c.customer_verified_by,
               c.created_at, c.updated_at,
               EXISTS(
                 SELECT 1
                   FROM signatures s
                   JOIN proposals p ON p.id = s.proposal_id
                   JOIN deals d ON d.id = p.deal_id
                  WHERE d.company_id = c.id
               ) AS has_signed_proposal
          FROM companies c
         ORDER BY c.name ASC
      `;
      return res.status(200).json(rows.map(serialiseCompany));
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const name = trimOrNull(body.name);
      if (!name) return res.status(400).json({ error: 'name is required' });
      const newId = body.id || makeId('co');
      await sql`
        INSERT INTO companies (id, name, domain, notes, xero_contact_id)
        VALUES (${newId}, ${name}, ${lowerOrNull(body.domain)}, ${trimOrNull(body.notes)}, ${trimOrNull(body.xeroContactId)})
      `;
      const rows = await sql`
        SELECT id, name, domain, notes, xero_contact_id, created_at, updated_at
        FROM companies WHERE id = ${newId}
      `;
      return res.status(201).json(serialiseCompany(rows[0]));
    }
    return res.status(405).end();
  }

  // /companies/:id/detail — company + member contacts + deals at the company
  if (action === 'detail' && req.method === 'GET') {
    const [companyRow] = await sql`
      SELECT c.id, c.name, c.domain, c.notes, c.xero_contact_id,
             c.customer_verified_at, c.customer_verified_by,
             c.created_at, c.updated_at,
             EXISTS(
               SELECT 1
                 FROM signatures s
                 JOIN proposals p ON p.id = s.proposal_id
                 JOIN deals d ON d.id = p.deal_id
                WHERE d.company_id = c.id
             ) AS has_signed_proposal
        FROM companies c
       WHERE c.id = ${id}
    `;
    if (!companyRow) return res.status(404).json({ error: 'Not found' });

    const [contactRows, dealRows] = await Promise.all([
      sql`
        SELECT id, email, name, phone, title, company_id, notes, created_at, updated_at
        FROM contacts WHERE company_id = ${id}
        ORDER BY name ASC NULLS LAST, email ASC
      `,
      sql`
        SELECT d.id, d.title, d.company_id, d.primary_contact_id, d.owner_email,
               d.stage, d.value, d.expected_close_at, d.stage_changed_at,
               d.last_activity_at, d.created_at, d.updated_at,
               (SELECT COUNT(*)::int FROM proposals p WHERE p.deal_id = d.id) AS proposal_count
          FROM deals d
          WHERE d.company_id = ${id}
          ORDER BY d.stage_changed_at DESC
      `,
    ]);

    return res.status(200).json({
      ...serialiseCompany(companyRow),
      contacts: contactRows.map(c => ({
        id: c.id,
        email: c.email || null,
        name: c.name || null,
        phone: c.phone || null,
        title: c.title || null,
        companyId: c.company_id || null,
        notes: c.notes || null,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      })),
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

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const cur = (await sql`
      SELECT id, name, domain, notes, xero_contact_id,
             customer_verified_at, customer_verified_by, created_at, updated_at
      FROM companies WHERE id = ${id}
    `)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const next = {
      name:   'name'   in body ? (trimOrNull(body.name) || cur.name) : cur.name,
      domain: 'domain' in body ? lowerOrNull(body.domain) : cur.domain,
      notes:  'notes'  in body ? trimOrNull(body.notes) : cur.notes,
      xero_contact_id: 'xeroContactId' in body ? trimOrNull(body.xeroContactId) : cur.xero_contact_id,
    };
    // Customer-verified is a toggle. Truthy → stamp now + caller; falsy → clear both.
    let verifiedAt = cur.customer_verified_at;
    let verifiedBy = cur.customer_verified_by;
    if ('customerVerified' in body) {
      if (body.customerVerified) {
        verifiedAt = new Date();
        verifiedBy = user.email || null;
      } else {
        verifiedAt = null;
        verifiedBy = null;
      }
    }
    await sql`
      UPDATE companies
         SET name = ${next.name},
             domain = ${next.domain},
             notes = ${next.notes},
             xero_contact_id = ${next.xero_contact_id},
             customer_verified_at = ${verifiedAt},
             customer_verified_by = ${verifiedBy},
             updated_at = NOW()
       WHERE id = ${id}
    `;
    const rows = await sql`
      SELECT c.id, c.name, c.domain, c.notes, c.xero_contact_id,
             c.customer_verified_at, c.customer_verified_by,
             c.created_at, c.updated_at,
             EXISTS(
               SELECT 1
                 FROM signatures s
                 JOIN proposals p ON p.id = s.proposal_id
                 JOIN deals d ON d.id = p.deal_id
                WHERE d.company_id = c.id
             ) AS has_signed_proposal
        FROM companies c
       WHERE c.id = ${id}
    `;
    return res.status(200).json(serialiseCompany(rows[0]));
  }
  if (req.method === 'DELETE') {
    if (!hasPermission(await getRole(user.role), 'companies.manage_all')) {
      return res.status(403).json({ error: 'You do not have permission to delete companies' });
    }
    await sql`DELETE FROM companies WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }
  return res.status(405).end();
}

export function serialiseCompany(r) {
  const verifiedAt = r.customer_verified_at || null;
  const hasSigned = !!r.has_signed_proposal;
  return {
    id: r.id,
    name: r.name,
    domain: r.domain || null,
    notes: r.notes || null,
    xeroContactId: r.xero_contact_id || null,
    customerVerifiedAt: verifiedAt,
    customerVerifiedBy: r.customer_verified_by || null,
    // hasSignedProposal is only present on rows that came from a list/detail
    // SELECT — older serialise call-sites (e.g. quote-request qualify) just
    // get `undefined` here, which the SPA treats as `false`. That's fine
    // because the SPA refreshes companies on the next interaction anyway.
    hasSignedProposal: r.has_signed_proposal !== undefined ? hasSigned : null,
    isCustomer: !!verifiedAt || hasSigned,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
