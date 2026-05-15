import sql from '../db.js';
import { makeId, trimOrNull } from './shared.js';
import { verifyTaskActionToken } from '../auth.js';
import { APP_URL } from '../email.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';

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
    const cur = (await sql`
      SELECT title, notes, due_at, assignee_email, contact_id, done_at
      FROM tasks WHERE id = ${id}
    `)[0];
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
    const allowed = rows[0].created_by === user.email
      || (Array.isArray(rows[0].assignees) && rows[0].assignees.includes(user.email))
      || hasPermission(await getRole(user.role), 'tasks.manage_all');
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });
    await sql`DELETE FROM tasks WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}

// One-click "Mark as done" from a reminder email. Auth comes from the signed
// token in the URL (audience: task-action), so no session is required.
export async function taskDoneLinkRoute(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  const taskId = url.searchParams.get('_id');
  if (!token || !taskId) return res.status(400).send(renderTaskActionPage({ title: 'Bad request', body: 'Missing token.' }));

  let payload;
  try {
    payload = await verifyTaskActionToken(token);
  } catch (err) {
    return res.status(401).send(renderTaskActionPage({
      title: 'Link expired',
      body: 'This one-click link is no longer valid. Open Squideo to mark the task done.',
    }));
  }
  if (payload.taskId !== taskId || payload.act !== 'done') {
    return res.status(400).send(renderTaskActionPage({ title: 'Bad request', body: 'Token does not match this task.' }));
  }

  // Idempotent: only flip if currently undone. Concurrent clicks won't reopen.
  const rows = await sql`
    UPDATE tasks
       SET done_at = NOW()
     WHERE id = ${taskId} AND done_at IS NULL
     RETURNING deal_id, title
  `;
  if (rows.length) {
    const { deal_id, title } = rows[0];
    if (deal_id) {
      await sql`
        INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
        VALUES (${deal_id}, 'task_done', ${JSON.stringify({ taskId, title, via: 'email' })}, ${payload.email || null})
      `;
      await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${deal_id}`;
    }
    return res.status(200).send(renderTaskActionPage({
      title: 'Task marked done',
      body: `<strong>${escapeForHtml(title || 'Your task')}</strong> is now complete.`,
    }));
  }

  // Either the task doesn't exist or it was already done. Surface both as
  // benign so re-clicking the link doesn't feel like an error.
  const existing = await sql`SELECT title, done_at FROM tasks WHERE id = ${taskId}`;
  if (!existing.length) {
    return res.status(404).send(renderTaskActionPage({ title: 'Task not found', body: 'It may have been deleted.' }));
  }
  return res.status(200).send(renderTaskActionPage({
    title: 'Already done',
    body: `<strong>${escapeForHtml(existing[0].title || 'This task')}</strong> was already marked complete.`,
  }));
}

function escapeForHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderTaskActionPage({ title, body }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeForHtml(title)} · Squideo</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:48px 16px;background:#FAFBFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0F2A3D;}
.card{max-width:480px;margin:0 auto;background:#fff;border:1px solid #E5E9EE;border-radius:12px;padding:32px;text-align:center;}
h1{margin:0 0 12px;font-size:22px;}p{margin:0 0 20px;color:#3B4A57;line-height:1.5;}
a.btn{display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;}</style>
</head><body><div class="card">
<h1>${escapeForHtml(title)}</h1>
<p>${body}</p>
<p><a class="btn" href="${escapeForHtml(APP_URL)}">Open Squideo</a></p>
</div></body></html>`;
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
