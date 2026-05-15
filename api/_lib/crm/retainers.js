import sql from '../db.js';
import { makeId, trimOrNull, numberOrNull } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';

export async function retainersRoute(req, res, id, action, user) {
  // --- GET /api/crm/retainers?dealId=
  if (!id && req.method === 'GET') {
    const dealId = trimOrNull(req.query.dealId);
    if (!dealId) return res.status(400).json({ error: 'dealId required' });

    const retainers = await sql`
      SELECT r.id, r.deal_id, r.contact_id, r.title,
             r.allocation_type, r.allocation_amount, r.currency,
             r.notes, r.status, r.created_by, r.created_at, r.updated_at,
             c.name AS contact_name, c.email AS contact_email
        FROM project_retainers r
        LEFT JOIN contacts c ON c.id = r.contact_id
       WHERE r.deal_id = ${dealId}
       ORDER BY r.created_at ASC
    `;

    if (!retainers.length) return res.status(200).json([]);

    const retainerIds = retainers.map(r => r.id);
    const entries = await sql`
      SELECT e.id, e.retainer_id, e.description, e.value, e.worked_at,
             e.created_by, e.created_at
        FROM project_retainer_entries e
       WHERE e.retainer_id = ANY(${retainerIds})
       ORDER BY e.worked_at DESC, e.created_at DESC
    `;

    const entriesByRetainer = new Map();
    for (const e of entries) {
      if (!entriesByRetainer.has(e.retainer_id)) entriesByRetainer.set(e.retainer_id, []);
      entriesByRetainer.get(e.retainer_id).push(normaliseEntry(e));
    }

    const out = retainers.map(r => ({
      id: r.id,
      dealId: r.deal_id,
      contactId: r.contact_id || null,
      contactName: r.contact_name || null,
      contactEmail: r.contact_email || null,
      title: r.title,
      allocationType: r.allocation_type,
      allocationAmount: Number(r.allocation_amount),
      currency: r.currency,
      notes: r.notes || null,
      status: r.status || 'active',
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      entries: entriesByRetainer.get(r.id) || [],
    }));

    return res.status(200).json(out);
  }

  // --- POST /api/crm/retainers — create retainer
  if (!id && req.method === 'POST') {
    const body = req.body || {};
    const dealId           = trimOrNull(body.dealId);
    const contactId        = trimOrNull(body.contactId);
    const title            = trimOrNull(body.title);
    const allocationType   = trimOrNull(body.allocationType);
    const allocationAmount = numberOrNull(body.allocationAmount);
    const currency         = trimOrNull(body.currency) || 'GBP';
    const notes            = trimOrNull(body.notes);

    if (!dealId)           return res.status(400).json({ error: 'dealId required' });
    if (!title)            return res.status(400).json({ error: 'title required' });
    if (!allocationType || !['money', 'credits'].includes(allocationType))
      return res.status(400).json({ error: 'allocationType must be money or credits' });
    if (allocationAmount == null || allocationAmount <= 0)
      return res.status(400).json({ error: 'allocationAmount must be positive' });

    const newId = makeId('ret');
    await sql`
      INSERT INTO project_retainers
        (id, deal_id, contact_id, title, allocation_type, allocation_amount, currency, notes, created_by)
      VALUES
        (${newId}, ${dealId}, ${contactId}, ${title}, ${allocationType}, ${allocationAmount}, ${currency}, ${notes}, ${user.email})
    `;

    return res.status(201).json({
      id: newId, dealId, contactId, title,
      allocationType, allocationAmount, currency, notes,
      createdBy: user.email, entries: [],
    });
  }

  // --- PATCH /api/crm/retainers/:id — update retainer
  if (id && !action && req.method === 'PATCH') {
    const cur = (await sql`SELECT * FROM project_retainers WHERE id = ${id}`)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });

    const body = req.body || {};
    const next = {
      contact_id:        'contactId'        in body ? trimOrNull(body.contactId)                             : cur.contact_id,
      title:             'title'            in body ? trimOrNull(body.title)                                 : cur.title,
      allocation_type:   'allocationType'   in body ? trimOrNull(body.allocationType)                        : cur.allocation_type,
      allocation_amount: 'allocationAmount' in body ? numberOrNull(body.allocationAmount)                    : cur.allocation_amount,
      currency:          'currency'         in body ? (trimOrNull(body.currency) || 'GBP')                  : cur.currency,
      notes:             'notes'            in body ? trimOrNull(body.notes)                                 : cur.notes,
      status:            'status'           in body ? trimOrNull(body.status)                                : cur.status,
    };

    if (!next.title)           return res.status(400).json({ error: 'title required' });
    if (!['money', 'credits'].includes(next.allocation_type))
      return res.status(400).json({ error: 'allocationType must be money or credits' });
    if (!next.allocation_amount || next.allocation_amount <= 0)
      return res.status(400).json({ error: 'allocationAmount must be positive' });
    if (!['active', 'completed', 'archived'].includes(next.status))
      return res.status(400).json({ error: 'status must be active, completed or archived' });

    await sql`
      UPDATE project_retainers
         SET contact_id        = ${next.contact_id},
             title             = ${next.title},
             allocation_type   = ${next.allocation_type},
             allocation_amount = ${next.allocation_amount},
             currency          = ${next.currency},
             notes             = ${next.notes},
             status            = ${next.status},
             updated_at        = NOW()
       WHERE id = ${id}
    `;
    return res.status(200).json({ ok: true });
  }

  // --- DELETE /api/crm/retainers/:id — delete retainer (entries cascade).
  // Gated to invoices.manage: the deal owner can archive, but a hard delete
  // that wipes the work log is restricted.
  if (id && !action && req.method === 'DELETE') {
    if (!hasPermission(await getRole(user.role), 'invoices.manage')) {
      return res.status(403).json({ error: 'You do not have permission to delete retainers' });
    }
    const cur = (await sql`SELECT id FROM project_retainers WHERE id = ${id}`)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    await sql`DELETE FROM project_retainers WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  // --- POST /api/crm/retainers/:id/entries — add a work entry
  if (id && action === 'entries' && req.method === 'POST') {
    const cur = (await sql`SELECT id FROM project_retainers WHERE id = ${id}`)[0];
    if (!cur) return res.status(404).json({ error: 'Retainer not found' });

    const body = req.body || {};
    const description = trimOrNull(body.description);
    const value       = numberOrNull(body.value);
    const workedAt    = trimOrNull(body.workedAt) || new Date().toISOString().slice(0, 10);

    if (!description) return res.status(400).json({ error: 'description required' });
    if (value == null || value <= 0) return res.status(400).json({ error: 'value must be positive' });

    const newId = makeId('rte');
    await sql`
      INSERT INTO project_retainer_entries
        (id, retainer_id, description, value, worked_at, created_by)
      VALUES
        (${newId}, ${id}, ${description}, ${value}, ${workedAt}, ${user.email})
    `;
    return res.status(201).json(normaliseEntry({
      id: newId, retainer_id: id, description, value, worked_at: workedAt,
      created_by: user.email, created_at: new Date().toISOString(),
    }));
  }

  // --- DELETE /api/crm/retainers/entries/:entryId — delete a work entry
  // Routed as id='entries', action=entryId by the slug dispatcher
  if (id === 'entries' && action && req.method === 'DELETE') {
    const entryId = action;
    const cur = (await sql`SELECT id FROM project_retainer_entries WHERE id = ${entryId}`)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    await sql`DELETE FROM project_retainer_entries WHERE id = ${entryId}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}

function normaliseEntry(e) {
  return {
    id: e.id,
    retainerId: e.retainer_id,
    description: e.description,
    value: Number(e.value),
    workedAt: e.worked_at,
    createdBy: e.created_by,
    createdAt: e.created_at,
  };
}
