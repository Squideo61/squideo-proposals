import sql from '../db.js';
import { makeId, trimOrNull, lowerOrNull } from './shared.js';

export async function contactsRoute(req, res, id, action, user) {
  if (!id) {
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, email, name, phone, title, company_id, notes, created_at, updated_at
        FROM contacts
        ORDER BY name ASC NULLS LAST, email ASC
      `;
      return res.status(200).json(rows.map(serialiseContact));
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const newId = body.id || makeId('ct');
      await sql`
        INSERT INTO contacts (id, email, name, phone, title, company_id, notes)
        VALUES (
          ${newId},
          ${lowerOrNull(body.email)},
          ${trimOrNull(body.name)},
          ${trimOrNull(body.phone)},
          ${trimOrNull(body.title)},
          ${trimOrNull(body.companyId) || null},
          ${trimOrNull(body.notes)}
        )
      `;
      const rows = await sql`
        SELECT id, email, name, phone, title, company_id, notes, created_at, updated_at
        FROM contacts WHERE id = ${newId}
      `;
      return res.status(201).json(serialiseContact(rows[0]));
    }
    return res.status(405).end();
  }

  // /contacts/:id/detail — contact + company + deals where they're primary
  if (action === 'detail' && req.method === 'GET') {
    const [contactRow] = await sql`
      SELECT id, email, name, phone, title, company_id, notes, created_at, updated_at
      FROM contacts WHERE id = ${id}
    `;
    if (!contactRow) return res.status(404).json({ error: 'Not found' });

    const [companyRows, dealRows] = await Promise.all([
      contactRow.company_id
        ? sql`SELECT id, name, domain, notes, created_at, updated_at
              FROM companies WHERE id = ${contactRow.company_id}`
        : Promise.resolve([]),
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

    return res.status(200).json({
      ...serialiseContact(contactRow),
      company: companyRows[0] ? {
        id: companyRows[0].id,
        name: companyRows[0].name,
        domain: companyRows[0].domain || null,
        notes: companyRows[0].notes || null,
        createdAt: companyRows[0].created_at,
        updatedAt: companyRows[0].updated_at,
      } : null,
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
    // Read-modify-write keeps the SQL simple — this table is small.
    const cur = (await sql`
      SELECT id, email, name, phone, title, company_id, notes, created_at, updated_at
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
    const rows = await sql`
      SELECT id, email, name, phone, title, company_id, notes, created_at, updated_at
      FROM contacts WHERE id = ${id}
    `;
    return res.status(200).json(serialiseContact(rows[0]));
  }
  if (req.method === 'DELETE') {
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    await sql`DELETE FROM contacts WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }
  return res.status(405).end();
}

function serialiseContact(r) {
  return {
    id: r.id,
    email: r.email || null,
    name: r.name || null,
    phone: r.phone || null,
    title: r.title || null,
    companyId: r.company_id || null,
    notes: r.notes || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
