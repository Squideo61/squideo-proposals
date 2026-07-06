import sql from '../db.js';
import { makeId, trimOrNull } from './shared.js';
import { verifyTaskActionToken } from '../auth.js';
import { APP_URL } from '../email.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { archiveRecord } from './recycleBin.js';
import { scheduleMilestones } from '../scheduleTemplate.js';

// Self-heal for the milestone columns (schedule-derived tasks). Module-level
// cached: a successful first call short-circuits later ones for the lifetime of
// the serverless instance. Same pattern as the production/shared ensure*.
let milestoneColumnsEnsured = null;
function ensureMilestoneColumns() {
  if (milestoneColumnsEnsured) return milestoneColumnsEnsured;
  milestoneColumnsEnsured = (async () => {
    await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_milestone BOOLEAN NOT NULL DEFAULT false`;
    await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS schedule_key TEXT`;
    await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pre_reminded_at TIMESTAMPTZ`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS tasks_schedule_key_uidx ON tasks(schedule_key) WHERE schedule_key IS NOT NULL`;
  })().catch((err) => { milestoneColumnsEnsured = null; throw err; });
  return milestoneColumnsEnsured;
}

// Reconcile a deal's production schedule into milestone-flagged tasks.
// Idempotent: upsert by schedule_key, delete rows whose schedule field was
// removed/disabled, so re-running never duplicates and clearing dates removes
// the tasks. Also pushes the fresh dates onto the producer rota. Returns
// { created, updated, removed } or { notFound: true }. Shared by the
// "Move to milestones" endpoint AND the deal-save hook (so editing/clearing
// dates keeps the milestones + rota in step). `existingOnly` skips creating new
// milestone rows — used by the save hook so a plain save never conjures
// milestones the user hasn't opted into.
export async function reconcileDealMilestones(dealId, { tzOffsetMinutes = 0, actorEmail = null, existingOnly = false } = {}) {
  await ensureMilestoneColumns();
  await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS production_schedule JSONB`.catch(() => {});

  const dealRows = await sql`SELECT id, owner_email, producer_email, production_schedule FROM deals WHERE id = ${dealId}`;
  if (!dealRows.length) return { notFound: true };
  const deal = dealRows[0];

  // Per-stage milestone assignment: every milestone → Production Managers
  // (role 'member'); Script stages → also the copywriting team (Chloe/Hannah);
  // Storyboard onward → also the project's producer(s). Best-effort.
  let productionManagers = [];
  try {
    const pmRows = await sql`SELECT email FROM users WHERE role = 'member'`;
    productionManagers = pmRows.map(r => r.email).filter(Boolean);
  } catch { /* best-effort */ }
  if (!productionManagers.length && deal.owner_email) productionManagers = [deal.owner_email];

  let scriptTeam = [];
  try {
    const scriptRows = await sql`SELECT email FROM users WHERE name ILIKE 'chloe%' OR name ILIKE 'hannah%'`;
    scriptTeam = scriptRows.map(r => r.email).filter(Boolean);
  } catch { /* best-effort */ }

  const producerRows = await sql`SELECT user_email FROM deal_assignees WHERE deal_id = ${dealId} ORDER BY assigned_at`;
  const producers = producerRows.length ? producerRows.map(r => r.user_email) : (deal.producer_email ? [deal.producer_email] : []);

  const assigneesForGroup = (group) => {
    const set = new Set(productionManagers);
    if (group === 'script') scriptTeam.forEach(e => e && set.add(e));
    else if (group === 'production') producers.forEach(e => e && set.add(e));
    return Array.from(set).filter(Boolean);
  };

  const desired = scheduleMilestones(deal.production_schedule, dealId, tzOffsetMinutes);
  const desiredKeys = new Set(desired.map(d => d.scheduleKey));
  const existing = await sql`SELECT id, schedule_key, due_at FROM tasks WHERE deal_id = ${dealId} AND is_milestone = true`;
  const existingByKey = new Map(existing.filter(e => e.schedule_key).map(e => [e.schedule_key, e]));

  let created = 0, updated = 0, removed = 0;
  for (const m of desired) {
    const assignees = assigneesForGroup(m.assignGroup);
    const prev = existingByKey.get(m.scheduleKey);
    if (prev) {
      const dateChanged = (prev.due_at ? new Date(prev.due_at).toISOString() : null) !== m.dueAt;
      if (dateChanged) {
        await sql`UPDATE tasks SET title = ${m.title}, due_at = ${m.dueAt}, assignee_email = ${assignees[0] || null}, reminded_at = NULL, pre_reminded_at = NULL WHERE id = ${prev.id}`;
      } else {
        await sql`UPDATE tasks SET title = ${m.title}, due_at = ${m.dueAt}, assignee_email = ${assignees[0] || null} WHERE id = ${prev.id}`;
      }
      await setTaskAssignees(prev.id, assignees);
      updated += 1;
    } else if (!existingOnly) {
      const newId = makeId('task');
      await sql`INSERT INTO tasks (id, deal_id, contact_id, title, notes, due_at, assignee_email, created_by, is_milestone, schedule_key)
        VALUES (${newId}, ${dealId}, ${null}, ${m.title}, ${'Auto-generated from the project schedule.'}, ${m.dueAt}, ${assignees[0] || null}, ${actorEmail}, true, ${m.scheduleKey})`;
      await setTaskAssignees(newId, assignees);
      created += 1;
    }
  }

  // Remove milestone tasks whose schedule field no longer exists (row disabled
  // or date cleared). Archive so the removal is restorable, like a delete.
  for (const e of existing) {
    if (!e.schedule_key || desiredKeys.has(e.schedule_key)) continue;
    const [taskRow] = await sql`SELECT * FROM tasks WHERE id = ${e.id}`;
    const assigneeRows = await sql`SELECT * FROM task_assignees WHERE task_id = ${e.id}`;
    if (taskRow) {
      await archiveRecord('task', e.id, [
        { table: 'tasks', row: taskRow },
        ...assigneeRows.map((a) => ({ table: 'task_assignees', row: a })),
      ], actorEmail);
    }
    await sql`DELETE FROM tasks WHERE id = ${e.id}`;
    removed += 1;
  }

  // Only stamp "milestones last synced" on an explicit sync, not a plain save.
  if (!existingOnly) {
    await sql`UPDATE deals SET production_schedule = jsonb_set(COALESCE(production_schedule, '{}'::jsonb), '{syncedAt}', to_jsonb(NOW()), true) WHERE id = ${dealId}`;
  }
  await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${dealId}`;

  // Push the fresh schedule dates onto the producer rota (best-effort).
  try { const { syncDealSchedule } = await import('./schedule.js'); await syncDealSchedule(dealId); }
  catch (err) { console.warn('[tasks] schedule sync failed', err.message); }

  return { created, updated, removed };
}

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
  // "Move to milestones" — reconcile a deal's production schedule into
  // milestone-flagged tasks. Idempotent: upsert by schedule_key, delete rows
  // whose schedule field was removed/disabled, so re-clicking never duplicates.
  if (id === 'sync-milestones') {
    if (req.method !== 'POST') return res.status(405).end();
    const dealId = trimOrNull((req.body || {}).dealId);
    if (!dealId) return res.status(400).json({ error: 'dealId is required' });
    const tzOffsetMinutes = Number((req.body || {}).tzOffsetMinutes) || 0;
    const result = await reconcileDealMilestones(dealId, { tzOffsetMinutes, actorEmail: user.email || null });
    if (result.notFound) return res.status(404).json({ error: 'Deal not found' });
    const tasks = await sql`
      SELECT t.*,
        (SELECT COALESCE(ARRAY_AGG(ta.user_email ORDER BY ta.assigned_at), '{}')
         FROM task_assignees ta WHERE ta.task_id = t.id) AS assignee_emails
      FROM tasks t WHERE t.deal_id = ${dealId} AND t.is_milestone = true
      ORDER BY t.due_at ASC NULLS LAST
    `;
    return res.status(200).json({ created: result.created, updated: result.updated, removed: result.removed, tasks: tasks.map(serialiseTask) });
  }

  if (!id) {
    if (req.method === 'GET') {
      const scope = String(req.query.scope || 'open');
      // Visibility: by default a user only sees tasks they're involved in —
      // assigned to them (join table or legacy column) or that they created.
      // `tasks.manage_all` (Admin) lifts the scope to the whole workspace so the
      // Tasks view's team filter can show everyone. The same `${canSeeAll}` flag
      // short-circuits the predicate in every scope variant below.
      const canSeeAll = hasPermission(await getRole(user.role), 'tasks.manage_all');
      const email = (user.email || '').toLowerCase();
      // Same correlated subquery in every variant so the serialiser sees
      // assignee_emails consistently.
      const rows = scope === 'all'
        ? await sql`
            SELECT t.*,
              (SELECT COALESCE(ARRAY_AGG(ta.user_email ORDER BY ta.assigned_at), '{}')
               FROM task_assignees ta WHERE ta.task_id = t.id) AS assignee_emails
            FROM tasks t
            WHERE (${canSeeAll}
                   OR LOWER(t.created_by) = ${email}
                   OR LOWER(t.assignee_email) = ${email}
                   OR EXISTS (SELECT 1 FROM task_assignees tm WHERE tm.task_id = t.id AND LOWER(tm.user_email) = ${email}))
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
              AND (${canSeeAll}
                   OR LOWER(t.created_by) = ${email}
                   OR LOWER(t.assignee_email) = ${email}
                   OR EXISTS (SELECT 1 FROM task_assignees tm WHERE tm.task_id = t.id AND LOWER(tm.user_email) = ${email}))
            ORDER BY due_at ASC
          `
        : scope === 'today'
        ? await sql`
            SELECT t.*,
              (SELECT COALESCE(ARRAY_AGG(ta.user_email ORDER BY ta.assigned_at), '{}')
               FROM task_assignees ta WHERE ta.task_id = t.id) AS assignee_emails
            FROM tasks t
            WHERE done_at IS NULL AND due_at::date = CURRENT_DATE
              AND (${canSeeAll}
                   OR LOWER(t.created_by) = ${email}
                   OR LOWER(t.assignee_email) = ${email}
                   OR EXISTS (SELECT 1 FROM task_assignees tm WHERE tm.task_id = t.id AND LOWER(tm.user_email) = ${email}))
            ORDER BY due_at ASC
          `
        : await sql`
            SELECT t.*,
              (SELECT COALESCE(ARRAY_AGG(ta.user_email ORDER BY ta.assigned_at), '{}')
               FROM task_assignees ta WHERE ta.task_id = t.id) AS assignee_emails
            FROM tasks t
            WHERE done_at IS NULL
              AND (${canSeeAll}
                   OR LOWER(t.created_by) = ${email}
                   OR LOWER(t.assignee_email) = ${email}
                   OR EXISTS (SELECT 1 FROM task_assignees tm WHERE tm.task_id = t.id AND LOWER(tm.user_email) = ${email}))
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
    // Archive the task + its assignees so the delete is restorable (CRM undo).
    const [taskRow] = await sql`SELECT * FROM tasks WHERE id = ${id}`;
    const assigneeRows = await sql`SELECT * FROM task_assignees WHERE task_id = ${id}`;
    if (taskRow) {
      await archiveRecord('task', id, [
        { table: 'tasks', row: taskRow },
        ...assigneeRows.map((a) => ({ table: 'task_assignees', row: a })),
      ], user.email);
    }
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
    isMilestone: !!r.is_milestone,
    scheduleKey: r.schedule_key || null,
  };
}
