// CRM endpoints — companies, contacts, deals, tasks, plus the cron sweep
// for task reminders. One slug-routed function file to stay within the
// Vercel Hobby 12-function cap.
import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';
import { sendMail, APP_URL } from '../_lib/email.js';
import { advanceStage, isValidStage, STAGES } from '../_lib/dealStage.js';

const makeId = (prefix) => prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

function trimOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function lowerOrNull(v) {
  const s = trimOrNull(v);
  return s ? s.toLowerCase() : null;
}
function numberOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Slug parsing — `[[...slug]]` makes `slug` an array like ['deals', 'abc', 'stage']
  // for /api/crm/deals/abc/stage, or undefined for /api/crm.
  const raw = req.query.slug;
  const segs = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
  const [resource, id, action] = segs;

  if (!resource) return res.status(404).json({ error: 'Not found' });

  // Cron sweep — auth via shared secret in Authorization header so the route
  // can be hit by Vercel cron without a JWT.
  if (resource === 'cron') {
    return cronHandler(req, res, action);
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    switch (resource) {
      case 'companies': return companiesRoute(req, res, id, action, user);
      case 'contacts':  return contactsRoute(req, res, id, action, user);
      case 'deals':     return dealsRoute(req, res, id, action, user);
      case 'tasks':     return tasksRoute(req, res, id, action, user);
      default:          return res.status(404).json({ error: 'Unknown resource: ' + resource });
    }
  } catch (err) {
    console.error('[crm] unhandled', { resource, id, action, method: req.method, err });
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}

// -------------------- Companies --------------------

async function companiesRoute(req, res, id, action, user) {
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
      const rows = await sql`SELECT * FROM companies WHERE id = ${newId}`;
      return res.status(201).json(serialiseCompany(rows[0]));
    }
    return res.status(405).end();
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const cur = (await sql`SELECT * FROM companies WHERE id = ${id}`)[0];
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
    const rows = await sql`SELECT * FROM companies WHERE id = ${id}`;
    return res.status(200).json(serialiseCompany(rows[0]));
  }
  if (req.method === 'DELETE') {
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

// -------------------- Contacts --------------------

async function contactsRoute(req, res, id, action, user) {
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

// -------------------- Deals --------------------

async function dealsRoute(req, res, id, action, user) {
  if (!id) {
    if (req.method === 'GET') {
      // Optional filter by stage, owner. Default: everything (Kanban renders
      // stages as columns and groups client-side).
      const stage = req.query.stage ? String(req.query.stage) : null;
      const owner = req.query.owner ? String(req.query.owner) : null;
      let rows;
      if (stage && owner) {
        rows = await sql`SELECT * FROM deals WHERE stage = ${stage} AND owner_email = ${owner} ORDER BY stage_changed_at DESC`;
      } else if (stage) {
        rows = await sql`SELECT * FROM deals WHERE stage = ${stage} ORDER BY stage_changed_at DESC`;
      } else if (owner) {
        rows = await sql`SELECT * FROM deals WHERE owner_email = ${owner} ORDER BY stage_changed_at DESC`;
      } else {
        rows = await sql`SELECT * FROM deals ORDER BY stage_changed_at DESC`;
      }

      // Annotate with primary contact + linked-proposal counts so the Kanban
      // can render without n+1 fetches.
      const ids = rows.map(r => r.id);
      const proposalCounts = ids.length
        ? await sql`SELECT deal_id, COUNT(*)::int AS n FROM proposals WHERE deal_id = ANY(${ids}) GROUP BY deal_id`
        : [];
      const propMap = new Map(proposalCounts.map(r => [r.deal_id, r.n]));

      return res.status(200).json(rows.map(r => ({
        ...serialiseDeal(r),
        proposalCount: propMap.get(r.id) || 0,
      })));
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const title = trimOrNull(body.title);
      if (!title) return res.status(400).json({ error: 'title is required' });
      const newId = body.id || makeId('deal');
      const stage = isValidStage(body.stage) ? body.stage : 'lead';
      await sql`
        INSERT INTO deals (id, title, company_id, primary_contact_id, owner_email, stage, value, expected_close_at, notes)
        VALUES (
          ${newId},
          ${title},
          ${trimOrNull(body.companyId) || null},
          ${trimOrNull(body.primaryContactId) || null},
          ${trimOrNull(body.ownerEmail) || user.email},
          ${stage},
          ${numberOrNull(body.value)},
          ${trimOrNull(body.expectedCloseAt)},
          ${trimOrNull(body.notes)}
        )
      `;
      await sql`
        INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
        VALUES (${newId}, 'deal_created', ${JSON.stringify({ title, stage, source: 'manual' })}, ${user.email || null})
      `;
      const rows = await sql`SELECT * FROM deals WHERE id = ${newId}`;
      return res.status(201).json(serialiseDeal(rows[0]));
    }
    return res.status(405).end();
  }

  // Sub-routes: /deals/:id/stage and /deals/:id/events
  if (action === 'stage') {
    if (req.method !== 'POST') return res.status(405).end();
    const { stage, lostReason } = req.body || {};
    if (!isValidStage(stage)) return res.status(400).json({ error: 'Invalid stage' });
    // Manual move: bypass the forward-only ratchet but still record an event.
    const cur = (await sql`SELECT stage FROM deals WHERE id = ${id}`)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    if (cur.stage === stage && stage !== 'lost') {
      return res.status(200).json({ ok: true, changed: false });
    }
    await sql`
      UPDATE deals
         SET stage = ${stage},
             stage_changed_at = NOW(),
             last_activity_at = NOW(),
             lost_reason = ${stage === 'lost' ? trimOrNull(lostReason) : null},
             updated_at = NOW()
       WHERE id = ${id}
    `;
    await sql`
      INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
      VALUES (${id}, 'stage_change', ${JSON.stringify({ from: cur.stage, to: stage, manual: true, lostReason: lostReason || null })}, ${user.email || null})
    `;
    const rows = await sql`SELECT * FROM deals WHERE id = ${id}`;
    return res.status(200).json({ ok: true, changed: true, deal: serialiseDeal(rows[0]) });
  }

  if (action === 'events') {
    if (req.method !== 'GET') return res.status(405).end();
    const rows = await sql`
      SELECT id, deal_id, event_type, payload, actor_email, occurred_at
      FROM deal_events
      WHERE deal_id = ${id}
      ORDER BY occurred_at DESC
      LIMIT 200
    `;
    return res.status(200).json(rows.map(r => ({
      id: Number(r.id),
      dealId: r.deal_id,
      eventType: r.event_type,
      payload: r.payload || {},
      actorEmail: r.actor_email || null,
      occurredAt: r.occurred_at,
    })));
  }

  // /deals/:id (no action)
  if (req.method === 'GET') {
    const rows = await sql`SELECT * FROM deals WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const deal = serialiseDeal(rows[0]);
    const [proposals, events, tasks] = await Promise.all([
      sql`SELECT id, data, number_year, number_seq, created_at FROM proposals WHERE deal_id = ${id} ORDER BY created_at DESC`,
      sql`SELECT id, deal_id, event_type, payload, actor_email, occurred_at FROM deal_events WHERE deal_id = ${id} ORDER BY occurred_at DESC LIMIT 100`,
      sql`SELECT * FROM tasks WHERE deal_id = ${id} ORDER BY done_at NULLS FIRST, due_at ASC NULLS LAST LIMIT 50`,
    ]);
    return res.status(200).json({
      ...deal,
      proposals: proposals.map(p => ({
        id: p.id,
        clientName: p.data?.clientName || null,
        contactBusinessName: p.data?.contactBusinessName || null,
        basePrice: p.data?.basePrice || null,
        number: p.number_year && p.number_seq ? { year: p.number_year, seq: p.number_seq } : null,
        createdAt: p.created_at,
      })),
      events: events.map(e => ({
        id: Number(e.id),
        eventType: e.event_type,
        payload: e.payload || {},
        actorEmail: e.actor_email || null,
        occurredAt: e.occurred_at,
      })),
      tasks: tasks.map(serialiseTask),
    });
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const cur = (await sql`SELECT * FROM deals WHERE id = ${id}`)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const next = {
      title:               'title'             in body ? (trimOrNull(body.title) || cur.title) : cur.title,
      company_id:          'companyId'         in body ? (trimOrNull(body.companyId) || null) : cur.company_id,
      primary_contact_id:  'primaryContactId'  in body ? (trimOrNull(body.primaryContactId) || null) : cur.primary_contact_id,
      owner_email:         'ownerEmail'        in body ? (trimOrNull(body.ownerEmail) || null) : cur.owner_email,
      value:               'value'             in body ? numberOrNull(body.value) : cur.value,
      expected_close_at:   'expectedCloseAt'   in body ? (trimOrNull(body.expectedCloseAt)) : cur.expected_close_at,
      notes:               'notes'             in body ? trimOrNull(body.notes) : cur.notes,
    };
    await sql`
      UPDATE deals SET
        title = ${next.title},
        company_id = ${next.company_id},
        primary_contact_id = ${next.primary_contact_id},
        owner_email = ${next.owner_email},
        value = ${next.value},
        expected_close_at = ${next.expected_close_at},
        notes = ${next.notes},
        last_activity_at = NOW(),
        updated_at = NOW()
      WHERE id = ${id}
    `;
    const rows = await sql`SELECT * FROM deals WHERE id = ${id}`;
    return res.status(200).json(serialiseDeal(rows[0]));
  }

  if (req.method === 'DELETE') {
    await sql`DELETE FROM deals WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}

function serialiseDeal(r) {
  return {
    id: r.id,
    title: r.title,
    companyId: r.company_id || null,
    primaryContactId: r.primary_contact_id || null,
    ownerEmail: r.owner_email || null,
    stage: r.stage,
    stageChangedAt: r.stage_changed_at,
    value: r.value === null || r.value === undefined ? null : Number(r.value),
    expectedCloseAt: r.expected_close_at || null,
    lostReason: r.lost_reason || null,
    notes: r.notes || null,
    lastActivityAt: r.last_activity_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// -------------------- Tasks --------------------

async function tasksRoute(req, res, id, action, user) {
  if (!id) {
    if (req.method === 'GET') {
      const scope = String(req.query.scope || 'open');
      const rows = scope === 'all'
        ? await sql`SELECT * FROM tasks ORDER BY done_at NULLS FIRST, due_at ASC NULLS LAST LIMIT 500`
        : scope === 'overdue'
        ? await sql`SELECT * FROM tasks WHERE done_at IS NULL AND due_at IS NOT NULL AND due_at < NOW() ORDER BY due_at ASC`
        : scope === 'today'
        ? await sql`SELECT * FROM tasks WHERE done_at IS NULL AND due_at::date = CURRENT_DATE ORDER BY due_at ASC`
        : await sql`SELECT * FROM tasks WHERE done_at IS NULL ORDER BY due_at ASC NULLS LAST LIMIT 500`;
      return res.status(200).json(rows.map(serialiseTask));
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const title = trimOrNull(body.title);
      if (!title) return res.status(400).json({ error: 'title is required' });
      const newId = body.id || makeId('task');
      await sql`
        INSERT INTO tasks (id, deal_id, contact_id, title, notes, due_at, assignee_email, created_by)
        VALUES (
          ${newId},
          ${trimOrNull(body.dealId) || null},
          ${trimOrNull(body.contactId) || null},
          ${title},
          ${trimOrNull(body.notes)},
          ${body.dueAt ? new Date(body.dueAt).toISOString() : null},
          ${trimOrNull(body.assigneeEmail) || user.email},
          ${user.email || null}
        )
      `;
      // Surface task creation on the deal's timeline.
      if (body.dealId) {
        await sql`
          INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
          VALUES (${body.dealId}, 'task_created', ${JSON.stringify({ taskId: newId, title, dueAt: body.dueAt || null })}, ${user.email || null})
        `;
        await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${body.dealId}`;
      }
      const rows = await sql`SELECT * FROM tasks WHERE id = ${newId}`;
      return res.status(201).json(serialiseTask(rows[0]));
    }
    return res.status(405).end();
  }

  if (action === 'done') {
    if (req.method !== 'POST') return res.status(405).end();
    const cur = (await sql`SELECT * FROM tasks WHERE id = ${id}`)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    await sql`UPDATE tasks SET done_at = NOW() WHERE id = ${id} AND done_at IS NULL`;
    if (cur.deal_id) {
      await sql`
        INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
        VALUES (${cur.deal_id}, 'task_done', ${JSON.stringify({ taskId: id, title: cur.title })}, ${user.email || null})
      `;
      await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${cur.deal_id}`;
    }
    const rows = await sql`SELECT * FROM tasks WHERE id = ${id}`;
    return res.status(200).json(serialiseTask(rows[0]));
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const cur = (await sql`SELECT * FROM tasks WHERE id = ${id}`)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const next = {
      title:           'title'         in body ? (trimOrNull(body.title) || cur.title) : cur.title,
      notes:           'notes'         in body ? trimOrNull(body.notes) : cur.notes,
      due_at:          'dueAt'         in body ? (body.dueAt ? new Date(body.dueAt).toISOString() : null) : cur.due_at,
      assignee_email:  'assigneeEmail' in body ? (trimOrNull(body.assigneeEmail) || null) : cur.assignee_email,
      contact_id:      'contactId'     in body ? (trimOrNull(body.contactId) || null) : cur.contact_id,
      done_at:         'done'          in body ? (body.done ? (cur.done_at || new Date().toISOString()) : null) : cur.done_at,
    };
    await sql`
      UPDATE tasks SET
        title = ${next.title},
        notes = ${next.notes},
        due_at = ${next.due_at},
        assignee_email = ${next.assignee_email},
        contact_id = ${next.contact_id},
        done_at = ${next.done_at},
        reminded_at = CASE WHEN ${next.due_at} IS DISTINCT FROM ${cur.due_at} THEN NULL ELSE reminded_at END
      WHERE id = ${id}
    `;
    const rows = await sql`SELECT * FROM tasks WHERE id = ${id}`;
    return res.status(200).json(serialiseTask(rows[0]));
  }

  if (req.method === 'DELETE') {
    await sql`DELETE FROM tasks WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}

function serialiseTask(r) {
  return {
    id: r.id,
    dealId: r.deal_id || null,
    contactId: r.contact_id || null,
    title: r.title,
    notes: r.notes || null,
    dueAt: r.due_at || null,
    assigneeEmail: r.assignee_email || null,
    doneAt: r.done_at || null,
    remindedAt: r.reminded_at || null,
    createdAt: r.created_at,
    createdBy: r.created_by || null,
  };
}

// -------------------- Cron: task reminders --------------------

async function cronHandler(req, res, action) {
  if (action !== 'task-reminders') return res.status(404).json({ error: 'Unknown cron action' });
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  // Vercel cron requests carry a Bearer token equal to CRON_SECRET. Reject
  // anything else so the endpoint isn't a public spam trigger.
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.warn('[cron] CRON_SECRET not set — refusing to run');
    return res.status(500).json({ error: 'Cron secret not configured' });
  }
  const auth = req.headers.authorization || '';
  if (auth !== 'Bearer ' + expected) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  // Daily 9am UTC sweep — pick up everything due in the next 24 hours that
  // hasn't been reminded yet. Granularity is intentionally coarse to fit
  // Vercel Hobby's 1-cron-per-day limit; on Pro this can move to */15.
  const due = await sql`
    SELECT t.id, t.title, t.due_at, t.assignee_email, t.deal_id, t.notes,
           d.title AS deal_title
    FROM tasks t
    LEFT JOIN deals d ON d.id = t.deal_id
    WHERE t.done_at IS NULL
      AND t.reminded_at IS NULL
      AND t.due_at IS NOT NULL
      AND t.due_at <= NOW() + INTERVAL '24 hours'
    ORDER BY t.due_at ASC
    LIMIT 200
  `;

  let sent = 0;
  for (const t of due) {
    if (!t.assignee_email) continue;
    const dueLabel = new Date(t.due_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    const dealLink = t.deal_id ? `${APP_URL}/?deal=${encodeURIComponent(t.deal_id)}` : APP_URL;
    const subject = `Reminder: ${t.title}`;
    const html = `
      <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;">Task due ${dueLabel}</h2>
      <p style="margin:0 0 12px;"><strong>${escapeHtml(t.title)}</strong>${t.deal_title ? ` — on deal <em>${escapeHtml(t.deal_title)}</em>` : ''}</p>
      ${t.notes ? `<p style="margin:0 0 16px;color:#6B7785;">${escapeHtml(t.notes)}</p>` : ''}
      <p style="margin:16px 0 0;"><a href="${dealLink}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Open in Squideo</a></p>
    `;
    const text = `Reminder: ${t.title} — due ${dueLabel}${t.deal_title ? ' (deal: ' + t.deal_title + ')' : ''}. ${dealLink}`;
    try {
      await sendMail({ to: t.assignee_email, subject, html, text });
      await sql`UPDATE tasks SET reminded_at = NOW() WHERE id = ${t.id}`;
      sent++;
    } catch (err) {
      console.error('[cron task-reminders] send failed', { taskId: t.id, err });
    }
  }

  return res.status(200).json({ ok: true, found: due.length, sent });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
