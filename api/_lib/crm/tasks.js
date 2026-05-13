import sql from '../db.js';
import { makeId, trimOrNull } from './shared.js';

// Accept either the new array field (`assigneeEmails`) or the legacy single
// (`assigneeEmail`) for one release so old clients don't break mid-deploy.
function readAssigneeEmails(body, fallback) {
  if (Array.isArray(body.assigneeEmails)) {
    const cleaned = body.assigneeEmails.map(trimOrNull).filter(Boolean);
    return cleaned.length ? Array.from(new Set(cleaned)) : (fallback ? [fallback] : []);
  }
  if ('assigneeEmail' in body) {
    const v = trimOrNull(body.assigneeEmail);
    return v ? [v] : (fallback ? [fallback] : []);
  }
  return fallback ? [fallback] : [];
}

async function setTaskAssignees(taskId, emails) {
  await sql`DELETE FROM task_assignees WHERE task_id = ${taskId}`;
  if (emails.length) {
    await sql`
      INSERT INTO task_assignees (task_id, user_email)
      SELECT ${taskId}, unnest(${emails}::text[])
      ON CONFLICT DO NOTHING
    `;
  }
}

async function loadTask(id) {
  const rows = await sql`
    SELECT t.*,
      (SELECT COALESCE(ARRAY_AGG(ta.user_email ORDER BY ta.assigned_at), '{}')
       FROM task_assignees ta WHERE ta.task_id = t.id) AS assignee_emails
    FROM tasks t
    WHERE t.id = ${id}
  `;
  return rows.length ? serialiseTask(rows[0]) : null;
}

export async function tasksRoute(req, res, id, action, user) {
  if (!id) {
    if (req.method === 'GET') {
      const scope = String(req.query.scope || 'open');
      // Same correlated subquery in every variant so the serialiser sees
      // assignee_emails consistently.
      const rows = scope === 'all'
        ? await sql`
            SELECT t.*,
              (SELECT COALESCE(ARRAY_AGG(ta.user_email ORDER BY ta.assigned_at), '{}')
               FROM task_assignees ta WHERE ta.task_id = t.id) AS assignee_emails
            FROM tasks t
            ORDER BY done_at NULLS FIRST, due_at ASC NULLS LAST
            LIMIT 500
          `
        : scope === 'overdue'
        ? await sql`
            SELECT t.*,
              (SELECT COALESCE(ARRAY_AGG(ta.user_email ORDER BY ta.assigned_at), '{}')
               FROM task_assignees ta WHERE ta.task_id = t.id) AS assignee_emails
            FROM tasks t
            WHERE done_at IS NULL AND due_at IS NOT NULL AND due_at < NOW()
            ORDER BY due_at ASC
          `
        : scope === 'today'
        ? await sql`
            SELECT t.*,
              (SELECT COALESCE(ARRAY_AGG(ta.user_email ORDER BY ta.assigned_at), '{}')
               FROM task_assignees ta WHERE ta.task_id = t.id) AS assignee_emails
            FROM tasks t
            WHERE done_at IS NULL AND due_at::date = CURRENT_DATE
            ORDER BY due_at ASC
          `
        : await sql`
            SELECT t.*,
              (SELECT COALESCE(ARRAY_AGG(ta.user_email ORDER BY ta.assigned_at), '{}')
               FROM task_assignees ta WHERE ta.task_id = t.id) AS assignee_emails
            FROM tasks t
            WHERE done_at IS NULL
            ORDER BY due_at ASC NULLS LAST
            LIMIT 500
          `;
      return res.status(200).json(rows.map(serialiseTask));
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const title = trimOrNull(body.title);
      if (!title) return res.status(400).json({ error: 'title is required' });
      const newId = body.id || makeId('task');
      const assignees = readAssigneeEmails(body, user.email);
      // Keep the legacy column populated with the first assignee for one
      // release so older code paths (e.g. cached UIs) still see a value.
      const legacyAssignee = assignees[0] || null;
      await sql`
        INSERT INTO tasks (id, deal_id, contact_id, title, notes, due_at, assignee_email, created_by)
        VALUES (
          ${newId},
          ${trimOrNull(body.dealId) || null},
          ${trimOrNull(body.contactId) || null},
          ${title},
          ${trimOrNull(body.notes)},
          ${body.dueAt ? new Date(body.dueAt).toISOString() : null},
          ${legacyAssignee},
          ${user.email || null}
        )
      `;
      await setTaskAssignees(newId, assignees);
      // Surface task creation on the deal's timeline.
      if (body.dealId) {
        await sql`
          INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
          VALUES (${body.dealId}, 'task_created', ${JSON.stringify({ taskId: newId, title, dueAt: body.dueAt || null })}, ${user.email || null})
        `;
        await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${body.dealId}`;
      }
      return res.status(201).json(await loadTask(newId));
    }
    return res.status(405).end();
  }

  if (action === 'done') {
    if (req.method !== 'POST') return res.status(405).end();
    // Atomic toggle: flip done_at between NULL and NOW(). The CASE makes
    // this race-safe at the DB level — concurrent clicks won't flip-flop.
    // We then log task_done or task_reopened depending on direction.
    const transitioned = await sql`
      UPDATE tasks
         SET done_at = CASE WHEN done_at IS NULL THEN NOW() ELSE NULL END
       WHERE id = ${id}
       RETURNING done_at, deal_id, title
    `;
    if (!transitioned.length) return res.status(404).json({ error: 'Not found' });
    const { done_at, deal_id, title } = transitioned[0];
    const eventType = done_at ? 'task_done' : 'task_reopened';
    if (deal_id) {
      await sql`
        INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
        VALUES (${deal_id}, ${eventType}, ${JSON.stringify({ taskId: id, title })}, ${user.email || null})
      `;
      await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${deal_id}`;
    }
    return res.status(200).json(await loadTask(id));
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const cur = (await sql`SELECT * FROM tasks WHERE id = ${id}`)[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    // Only touch assignees if the caller explicitly sent the field — partial
    // PATCHes that omit it must not wipe assignments.
    const assigneeKeyPresent = 'assigneeEmails' in body || 'assigneeEmail' in body;
    const nextAssignees = assigneeKeyPresent ? readAssigneeEmails(body, null) : null;
    const legacyAssigneeNext = assigneeKeyPresent
      ? (nextAssignees[0] || null)
      : cur.assignee_email;
    const next = {
      title:           'title'         in body ? (trimOrNull(body.title) || cur.title) : cur.title,
      notes:           'notes'         in body ? trimOrNull(body.notes) : cur.notes,
      due_at:          'dueAt'         in body ? (body.dueAt ? new Date(body.dueAt).toISOString() : null) : cur.due_at,
      assignee_email:  legacyAssigneeNext,
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
    if (assigneeKeyPresent) {
      await setTaskAssignees(id, nextAssignees);
    }
    return res.status(200).json(await loadTask(id));
  }

  if (req.method === 'DELETE') {
    // Creator, current assignee, or admin can delete. Anyone else is rejected.
    const rows = await sql`
      SELECT t.created_by,
        (SELECT COALESCE(ARRAY_AGG(ta.user_email), '{}') FROM task_assignees ta WHERE ta.task_id = t.id) AS assignees
      FROM tasks t WHERE t.id = ${id}
    `;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const allowed = user.role === 'admin'
      || rows[0].created_by === user.email
      || (Array.isArray(rows[0].assignees) && rows[0].assignees.includes(user.email));
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });
    await sql`DELETE FROM tasks WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}

export function serialiseTask(r) {
  const joined = Array.isArray(r.assignee_emails) ? r.assignee_emails.filter(Boolean) : [];
  // Fallback to the legacy column only when the join table is empty for this
  // task. The cleanup migration drops the column once this branch goes cold.
  const emails = joined.length ? joined : (r.assignee_email ? [r.assignee_email] : []);
  return {
    id: r.id,
    dealId: r.deal_id || null,
    contactId: r.contact_id || null,
    title: r.title,
    notes: r.notes || null,
    dueAt: r.due_at || null,
    assigneeEmails: emails,
    assigneeEmail: emails[0] || null, // legacy field for one release
    doneAt: r.done_at || null,
    remindedAt: r.reminded_at || null,
    createdAt: r.created_at,
    createdBy: r.created_by || null,
  };
}
