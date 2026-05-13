import sql from '../db.js';
import { makeId, trimOrNull, lowerOrNull } from './shared.js';

export async function companiesRoute(req, res, id, action, user) {
  if (!id) {
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, name, domain, notes, created_at, updated_at
        FROM companies
        ORDER BY name ASC
      `;
      return res.status(200).json(rows.map(serialiseCompany));
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const name = trimOrNull(body.name);
      if (!name) return res.status(400).json({ error: 'name is required' });
      const newId = body.id || makeId('co');
      await sql`
        INSERT INTO companies (id, name, domain, notes)
        VALUES (${newId}, ${name}, ${lowerOrNull(body.domain)}, ${trimOrNull(body.notes)})
      `;
      const rows = await sql`
        SELECT id, name, domain, notes, created_at, updated_at
        FROM companies WHERE id = ${newId}
      `;
      return res.status(201).json(serialiseCompany(rows[0]));
    }
    return res.status(405).end();
  }

  // /companies/:id/detail — company + member contacts + deals at the company
  if (action === 'detail' && req.method === 'GET') {
    const [companyRow] = await sql`
      SELECT id, name, domain, notes, created_at, updated_at
      FROM companies WHERE id = ${id}
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
      SELECT id, name, domain, notes, created_at, updated_at
      FROM companies WHERE id = ${id}
    `)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const next = {
      name:   'name'   in body ? (trimOrNull(body.name) || cur.name) : cur.name,
      domain: 'domain' in body ? lowerOrNull(body.domain) : cur.domain,
      notes:  'notes'  in body ? trimOrNull(body.notes) : cur.notes,
    };
    await sql`
      UPDATE companies
         SET name = ${next.name},
             domain = ${next.domain},
             notes = ${next.notes},
             updated_at = NOW()
       WHERE id = ${id}
    `;
    const rows = await sql`
      SELECT id, name, domain, notes, created_at, updated_at
      FROM companies WHERE id = ${id}
    `;
    return res.status(200).json(serialiseCompany(rows[0]));
  }
  if (req.method === 'DELETE') {
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    await sql`DELETE FROM companies WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }
  return res.status(405).end();
}

function serialiseCompany(r) {
  return {
    id: r.id,
    name: r.name,
    domain: r.domain || null,
    notes: r.notes || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
