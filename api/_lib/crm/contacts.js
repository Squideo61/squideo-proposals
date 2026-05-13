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
      const rows = await sql`SELECT * FROM contacts WHERE id = ${newId}`;
      return res.status(201).json(serialiseContact(rows[0]));
    }
    return res.status(405).end();
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    // Read-modify-write keeps the SQL simple — this table is small.
    const cur = (await sql`SELECT * FROM contacts WHERE id = ${id}`)[0];
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
    const rows = await sql`SELECT * FROM contacts WHERE id = ${id}`;
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
