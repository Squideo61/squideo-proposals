// CRM endpoints — companies, contacts, deals, tasks, Gmail OAuth + send,
// plus the cron sweep for task reminders. One slug-routed function file to
// stay within the Vercel Hobby 12-function cap.
import crypto from 'node:crypto';
import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';
import { sendMail, APP_URL } from '../_lib/email.js';
import { advanceStage, isValidStage, STAGES } from '../_lib/dealStage.js';
import {
  buildAuthUrl,
  encryptToken,
  decryptToken,
  exchangeCode,
  refreshAccessToken,
  fetchGmailAddress,
  registerWatch,
  stopWatch,
} from '../_lib/gmailTokens.js';
import {
  verifyPushJwt,
  parsePushBody,
  syncHistory,
} from '../_lib/gmailSync.js';

// gmail.readonly + gmail.modify give us message bodies + label updates.
// gmail.metadata is INTENTIONALLY OMITTED — it's mutually exclusive with
// gmail.readonly, and requesting both causes Google to grant the narrower
// metadata-only access (which then 403s on format=full reads).
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.readonly',
];

function gmailRedirectUri(req) {
  // Use the request's host so localhost dev and Vercel deploys both work.
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/crm/gmail/callback`;
}

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

  // Parse the path. Vercel's [...slug] catch-all in this project only matches
  // SINGLE-segment paths reliably (multi-segment 404s), so vercel.json
  // rewrites flatten /api/crm/:resource/:id/:action into
  // /api/crm/:resource?_id=:id&_action=:action and we recover id/action from
  // the query string here. Direct calls (e.g. /api/crm/companies, no id)
  // also work because the rewrites are conditional on having extra segments.
  const urlPath = (req.url || '').split('?')[0];
  const qs = (req.url || '').split('?')[1] || '';
  const queryParams = new URLSearchParams(qs);
  const segs = urlPath.split('/').filter(Boolean).slice(2); // strip 'api', 'crm'
  const resource = segs[0] || null;
  const id = segs[1] || queryParams.get('_id') || null;
  const action = segs[2] || queryParams.get('_action') || null;

  if (!resource) return res.status(404).json({ error: 'Not found' });

  // Cron sweep — auth via shared secret in Authorization header so the route
  // can be hit by Vercel cron without a JWT. After the rewrite, the cron
  // task name lands in `id` (e.g. /api/crm/cron/task-reminders → id='task-reminders').
  if (resource === 'cron') {
    return cronHandler(req, res, id || action);
  }

  // Gmail OAuth callback is hit by Google after consent — no JWT to send,
  // CSRF protection comes from the `state` token we stored before redirect.
  if (resource === 'gmail' && id === 'callback') {
    return gmailCallback(req, res);
  }

  // Pub/Sub push: Google calls this with a service-account-signed JWT; the
  // handler verifies it itself, so no app-level auth.
  if (resource === 'gmail' && id === 'push') {
    return gmailPush(req, res);
  }

  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    switch (resource) {
      case 'companies': return companiesRoute(req, res, id, action, user);
      case 'contacts':  return contactsRoute(req, res, id, action, user);
      case 'deals':     return dealsRoute(req, res, id, action, user);
      case 'tasks':     return tasksRoute(req, res, id, action, user);
      case 'gmail':     return gmailRoute(req, res, id, action, user);
      case 'triage':    return triageRoute(req, res, id, action, user);
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
    const [proposals, events, tasks, emails] = await Promise.all([
      sql`SELECT id, data, number_year, number_seq, created_at FROM proposals WHERE deal_id = ${id} ORDER BY created_at DESC`,
      sql`SELECT id, deal_id, event_type, payload, actor_email, occurred_at FROM deal_events WHERE deal_id = ${id} ORDER BY occurred_at DESC LIMIT 100`,
      sql`SELECT * FROM tasks WHERE deal_id = ${id} ORDER BY done_at NULLS FIRST, due_at ASC NULLS LAST LIMIT 50`,
      // Every email_message attached to this deal via the M:N join. The most
      // recent 50 keep the timeline manageable; older ones can be paged later.
      sql`
        SELECT em.gmail_message_id, em.gmail_thread_id, em.from_email,
               em.to_emails, em.cc_emails, em.subject, em.snippet,
               em.direction, em.sent_at, em.user_email
        FROM email_messages em
        JOIN email_thread_deals etd ON etd.gmail_thread_id = em.gmail_thread_id
        WHERE etd.deal_id = ${id} AND em.internal_only = FALSE
        ORDER BY em.sent_at DESC
        LIMIT 50
      `,
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
      emails: emails.map(em => ({
        gmailMessageId: em.gmail_message_id,
        gmailThreadId: em.gmail_thread_id,
        fromEmail: em.from_email || null,
        toEmails: em.to_emails || [],
        ccEmails: em.cc_emails || [],
        subject: em.subject || null,
        snippet: em.snippet || null,
        direction: em.direction,
        sentAt: em.sent_at,
        userEmail: em.user_email,
      })),
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

// -------------------- Triage (unmatched email messages) --------------------

async function triageRoute(req, res, id, action, user) {
  if (!id) {
    if (req.method !== 'GET') return res.status(405).end();
    // List the recent unmatched, non-internal messages for this user. Newest
    // first; cap at 100 so the UI can paginate later if needed.
    const rows = await sql`
      SELECT em.gmail_message_id, em.gmail_thread_id, em.from_email,
             em.to_emails, em.cc_emails, em.subject, em.snippet,
             em.direction, em.sent_at, em.user_email
      FROM email_messages em
      WHERE em.unmatched = TRUE
        AND em.internal_only = FALSE
        AND em.user_email = ${user.email}
        AND NOT EXISTS (
          SELECT 1 FROM email_thread_deals etd WHERE etd.gmail_thread_id = em.gmail_thread_id
        )
      ORDER BY em.sent_at DESC
      LIMIT 100
    `;
    return res.status(200).json(rows.map(em => ({
      gmailMessageId: em.gmail_message_id,
      gmailThreadId: em.gmail_thread_id,
      fromEmail: em.from_email || null,
      toEmails: em.to_emails || [],
      ccEmails: em.cc_emails || [],
      subject: em.subject || null,
      snippet: em.snippet || null,
      direction: em.direction,
      sentAt: em.sent_at,
      userEmail: em.user_email,
    })));
  }

  // /api/crm/triage/<gmail_thread_id>/assign
  if (action === 'assign') {
    if (req.method !== 'POST') return res.status(405).end();
    const { dealId } = req.body || {};
    if (!dealId) return res.status(400).json({ error: 'dealId required' });

    const deal = (await sql`SELECT id FROM deals WHERE id = ${dealId}`)[0];
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    // Idempotent attach. id here is the gmail_thread_id (URL: /triage/<thread>/assign).
    await sql`
      INSERT INTO email_thread_deals (gmail_thread_id, deal_id, resolved_by)
      VALUES (${id}, ${dealId}, 'manual')
      ON CONFLICT (gmail_thread_id, deal_id) DO NOTHING
    `;
    // Clear unmatched flag on every message in this thread.
    await sql`
      UPDATE email_messages SET unmatched = FALSE
      WHERE gmail_thread_id = ${id}
    `;
    await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${dealId}`;
    return res.status(200).json({ ok: true });
  }

  if (action === 'dismiss') {
    if (req.method !== 'POST') return res.status(405).end();
    // Mark every message in the thread as no-longer-unmatched without
    // attaching to any deal. Useful for spam/personal mail that landed in
    // the triage queue.
    await sql`UPDATE email_messages SET unmatched = FALSE WHERE gmail_thread_id = ${id}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(404).json({ error: 'Unknown triage action' });
}

// -------------------- Cron: task reminders --------------------

async function cronHandler(req, res, action) {
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

  switch (action) {
    case 'task-reminders':  return cronTaskReminders(res);
    case 'gmail-watch-renew': return cronGmailWatchRenew(res);
    default:                return res.status(404).json({ error: 'Unknown cron action: ' + action });
  }
}

async function cronTaskReminders(res) {
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

// Renew Gmail watches that are within 24 hours of expiring (Gmail watches
// last ~7 days). Spreads the work daily so we never have a flood. Best-
// effort per account so one failure doesn't block the others.
async function cronGmailWatchRenew(res) {
  const due = await sql`
    SELECT user_email, pubsub_topic
    FROM gmail_accounts
    WHERE disconnected_at IS NULL
      AND (watch_expires_at IS NULL OR watch_expires_at < NOW() + INTERVAL '24 hours')
  `;
  let renewed = 0;
  let failed = 0;
  for (const row of due) {
    const topic = row.pubsub_topic || process.env.GMAIL_PUBSUB_TOPIC;
    if (!topic) {
      console.warn('[cron watch-renew] no topic configured for', row.user_email);
      continue;
    }
    try {
      const accessToken = await getFreshAccessToken(row.user_email);
      const watch = await registerWatch(accessToken, topic);
      await sql`
        UPDATE gmail_accounts
           SET watch_expires_at = ${watch.expiration ? new Date(watch.expiration).toISOString() : null},
               history_id = COALESCE(history_id, ${watch.historyId}),
               pubsub_topic = ${topic},
               updated_at = NOW()
         WHERE user_email = ${row.user_email}
      `;
      renewed++;
    } catch (err) {
      console.error('[cron watch-renew] failed for', row.user_email, err.message);
      failed++;
    }
  }
  return res.status(200).json({ ok: true, considered: due.length, renewed, failed });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// -------------------- Gmail OAuth + send --------------------

async function gmailRoute(req, res, id, action, user) {
  // /api/crm/gmail               GET   — current connection status for the user
  // /api/crm/gmail/connect       GET   — returns Google auth URL to redirect to
  // /api/crm/gmail/disconnect    POST  — revoke + clear stored token
  // /api/crm/gmail/send          POST  — send an email via Gmail API
  // /api/crm/gmail/callback      GET   — public, handled in top-level dispatch

  if (!id) {
    if (req.method !== 'GET') return res.status(405).end();
    const rows = await sql`
      SELECT gmail_address, scopes, connected_at, disconnected_at, history_id
      FROM gmail_accounts WHERE user_email = ${user.email}
    `;
    if (!rows.length || rows[0].disconnected_at) {
      return res.status(200).json({ connected: false });
    }
    return res.status(200).json({
      connected: true,
      gmailAddress: rows[0].gmail_address,
      scopes: rows[0].scopes,
      connectedAt: rows[0].connected_at,
    });
  }

  if (id === 'connect') {
    if (req.method !== 'GET') return res.status(405).end();
    // CSRF-safe state token. We bind it to the user's email so an attacker
    // can't trade somebody else's authorisation code for their own account.
    const state = crypto.randomBytes(32).toString('base64url');
    await sql`
      INSERT INTO oauth_states (state, user_email, purpose)
      VALUES (${state}, ${user.email}, 'gmail-connect')
    `;
    // Best-effort cleanup of states older than 10 minutes.
    await sql`DELETE FROM oauth_states WHERE created_at < NOW() - INTERVAL '10 minutes'`;
    const url = buildAuthUrl({
      state,
      redirectUri: gmailRedirectUri(req),
      scopes: GMAIL_SCOPES,
    });
    return res.status(200).json({ url });
  }

  if (id === 'disconnect') {
    if (req.method !== 'POST') return res.status(405).end();
    const rows = await sql`
      SELECT refresh_token_enc, refresh_token_iv, refresh_token_tag
      FROM gmail_accounts WHERE user_email = ${user.email} AND disconnected_at IS NULL
    `;
    if (rows.length) {
      // Best-effort cleanup at Google's end. Revoking the refresh token also
      // invalidates any access token, but we proactively call users.stop too
      // so they tear down the Pub/Sub watch immediately rather than waiting
      // for it to expire.
      try {
        const refreshToken = decryptToken({
          enc: rows[0].refresh_token_enc,
          iv: rows[0].refresh_token_iv,
          tag: rows[0].refresh_token_tag,
        });
        try {
          const accessToken = await getFreshAccessToken(user.email);
          await stopWatch(accessToken);
        } catch (err) {
          console.warn('[gmail disconnect] users.stop failed (ignoring)', err.message);
        }
        await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(refreshToken), {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
      } catch (err) {
        console.warn('[gmail disconnect] revoke failed (ignoring)', err.message);
      }
    }
    await sql`
      UPDATE gmail_accounts
         SET disconnected_at = NOW(),
             history_id = NULL,
             watch_expires_at = NULL,
             updated_at = NOW()
       WHERE user_email = ${user.email}
    `;
    return res.status(200).json({ ok: true });
  }

  if (id === 'send') {
    if (req.method !== 'POST') return res.status(405).end();
    return gmailSend(req, res, user);
  }

  return res.status(404).json({ error: 'Unknown gmail action: ' + id });
}

async function gmailCallback(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  // Parse query params from req.url since req.query parsing was unreliable
  // for the catch-all routing earlier.
  const qs = (req.url || '').split('?')[1] || '';
  const params = new URLSearchParams(qs);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');

  const renderResult = (title, body) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).end(`<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#FAFBFC;color:#0F2A3D;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}main{background:#fff;border:1px solid #E5E9EE;border-radius:12px;padding:32px;max-width:440px;text-align:center;box-shadow:0 4px 20px rgba(15,42,61,0.06)}h1{font-size:18px;margin:0 0 12px}p{color:#6B7785;font-size:14px;margin:0 0 18px;line-height:1.5}a{display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px}</style></head>
<body><main>${body}<p style="margin-top:18px"><a href="${APP_URL}/">Back to Squideo</a></p></main></body></html>`);
  };

  if (error) {
    return renderResult('Connection cancelled', `<h1>Connection cancelled</h1><p>${escapeHtml(error)}</p>`);
  }
  if (!code || !state) {
    return renderResult('Connection failed', `<h1>Connection failed</h1><p>Missing code or state in the callback. Try again.</p>`);
  }

  // Validate state and look up which user it belongs to.
  const stateRows = await sql`
    SELECT user_email, purpose, created_at FROM oauth_states WHERE state = ${state}
  `;
  if (!stateRows.length) {
    return renderResult('Connection failed', `<h1>Connection failed</h1><p>State token unknown or expired. Try connecting again.</p>`);
  }
  const ageMs = Date.now() - new Date(stateRows[0].created_at).getTime();
  if (stateRows[0].purpose !== 'gmail-connect' || ageMs > 10 * 60 * 1000) {
    await sql`DELETE FROM oauth_states WHERE state = ${state}`;
    return renderResult('Connection failed', `<h1>Connection failed</h1><p>State token expired. Try connecting again.</p>`);
  }
  const userEmail = stateRows[0].user_email;
  await sql`DELETE FROM oauth_states WHERE state = ${state}`;

  // Exchange the auth code for tokens.
  let tokens;
  try {
    tokens = await exchangeCode(code, gmailRedirectUri(req));
  } catch (err) {
    console.error('[gmail callback] code exchange failed', err);
    return renderResult('Connection failed', `<h1>Connection failed</h1><p>${escapeHtml(err.message || 'Token exchange error.')}</p>`);
  }

  if (!tokens.refresh_token) {
    return renderResult('Connection failed', `<h1>Connection failed</h1><p>Google did not return a refresh token. Disconnect any prior connection from your Google account, then try again.</p>`);
  }

  // Confirm the access token is valid and grab the Gmail address.
  let gmailAddress;
  try {
    gmailAddress = await fetchGmailAddress(tokens.access_token);
  } catch (err) {
    console.error('[gmail callback] profile fetch failed', err);
    return renderResult('Connection failed', `<h1>Connection failed</h1><p>${escapeHtml(err.message || 'Could not read Gmail profile.')}</p>`);
  }

  const { enc, iv, tag } = encryptToken(tokens.refresh_token);
  const accessExpiresAt = new Date(Date.now() + (Number(tokens.expires_in || 3600) - 60) * 1000).toISOString();

  // Register a Gmail push subscription on the configured Pub/Sub topic so
  // we receive a notification whenever new mail arrives. Best-effort — if
  // it fails (e.g. topic not configured) we still persist the tokens so the
  // user can at least send email; the daily cron will retry.
  let historyId = null;
  let watchExpiresAt = null;
  let pubsubTopic = process.env.GMAIL_PUBSUB_TOPIC || null;
  if (pubsubTopic) {
    try {
      const watch = await registerWatch(tokens.access_token, pubsubTopic);
      historyId = watch.historyId || null;
      watchExpiresAt = watch.expiration ? new Date(watch.expiration).toISOString() : null;
    } catch (err) {
      console.error('[gmail callback] users.watch failed', err.message);
    }
  } else {
    console.warn('[gmail callback] GMAIL_PUBSUB_TOPIC not set — skipping watch registration');
  }

  await sql`
    INSERT INTO gmail_accounts (
      user_email, gmail_address,
      refresh_token_enc, refresh_token_iv, refresh_token_tag,
      access_token, access_token_expires_at,
      history_id, watch_expires_at, pubsub_topic,
      scopes, connected_at, disconnected_at, updated_at
    ) VALUES (
      ${userEmail}, ${gmailAddress},
      ${enc}, ${iv}, ${tag},
      ${tokens.access_token}, ${accessExpiresAt},
      ${historyId}, ${watchExpiresAt}, ${pubsubTopic},
      ${tokens.scope || GMAIL_SCOPES.join(' ')}, NOW(), NULL, NOW()
    )
    ON CONFLICT (user_email) DO UPDATE SET
      gmail_address = EXCLUDED.gmail_address,
      refresh_token_enc = EXCLUDED.refresh_token_enc,
      refresh_token_iv = EXCLUDED.refresh_token_iv,
      refresh_token_tag = EXCLUDED.refresh_token_tag,
      access_token = EXCLUDED.access_token,
      access_token_expires_at = EXCLUDED.access_token_expires_at,
      history_id = COALESCE(EXCLUDED.history_id, gmail_accounts.history_id),
      watch_expires_at = COALESCE(EXCLUDED.watch_expires_at, gmail_accounts.watch_expires_at),
      pubsub_topic = COALESCE(EXCLUDED.pubsub_topic, gmail_accounts.pubsub_topic),
      scopes = EXCLUDED.scopes,
      connected_at = NOW(),
      disconnected_at = NULL,
      updated_at = NOW()
  `;

  return renderResult(
    'Gmail connected',
    `<h1>Gmail connected ✓</h1><p><strong>${escapeHtml(gmailAddress)}</strong> is now linked to your Squideo account.</p><p>${historyId ? 'Inbound sync is active — new mail will appear on the matching deal automatically.' : 'Inbound sync could not be activated (Pub/Sub may need attention) — outbound send still works.'}</p><p>You can close this tab.</p>`
  );
}

// Fetch a fresh access token, refreshing via Google if the cached one is
// stale. Persists the new access_token + expiry. Throws if the user isn't
// connected or Google has revoked the refresh token.
async function getFreshAccessToken(userEmail) {
  const rows = await sql`
    SELECT refresh_token_enc, refresh_token_iv, refresh_token_tag,
           access_token, access_token_expires_at
    FROM gmail_accounts
    WHERE user_email = ${userEmail} AND disconnected_at IS NULL
  `;
  if (!rows.length) {
    const err = new Error('Gmail not connected');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const row = rows[0];
  const expiresAt = row.access_token_expires_at ? new Date(row.access_token_expires_at).getTime() : 0;
  if (row.access_token && expiresAt > Date.now() + 30_000) {
    return row.access_token;
  }
  const refreshToken = decryptToken({
    enc: row.refresh_token_enc,
    iv: row.refresh_token_iv,
    tag: row.refresh_token_tag,
  });
  let refreshed;
  try {
    refreshed = await refreshAccessToken(refreshToken);
  } catch (err) {
    if (String(err.message).includes('invalid_grant')) {
      // Token was revoked at Google's end — flag the account so the UI can
      // prompt the user to reconnect.
      await sql`
        UPDATE gmail_accounts
           SET disconnected_at = NOW(), updated_at = NOW()
         WHERE user_email = ${userEmail}
      `;
      const e = new Error('Gmail authorisation expired. Reconnect to continue.');
      e.code = 'REAUTH';
      throw e;
    }
    throw err;
  }
  await sql`
    UPDATE gmail_accounts
       SET access_token = ${refreshed.accessToken},
           access_token_expires_at = ${refreshed.expiresAt.toISOString()},
           updated_at = NOW()
     WHERE user_email = ${userEmail}
  `;
  return refreshed.accessToken;
}

async function gmailSend(req, res, user) {
  const body = req.body || {};
  const to = Array.isArray(body.to) ? body.to.filter(Boolean) : (body.to ? [body.to] : []);
  const cc = Array.isArray(body.cc) ? body.cc.filter(Boolean) : [];
  const bcc = Array.isArray(body.bcc) ? body.bcc.filter(Boolean) : [];
  const subject = trimOrNull(body.subject);
  const html = body.html || '';
  const text = body.text || '';
  const dealId = trimOrNull(body.dealId);
  const threadId = trimOrNull(body.gmailThreadId);

  if (!to.length) return res.status(400).json({ error: 'to is required' });
  if (!subject) return res.status(400).json({ error: 'subject is required' });
  if (!html && !text) return res.status(400).json({ error: 'html or text body is required' });

  let accessToken;
  try {
    accessToken = await getFreshAccessToken(user.email);
  } catch (err) {
    if (err.code === 'NOT_CONNECTED' || err.code === 'REAUTH') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const fromAddress = (await sql`
    SELECT gmail_address FROM gmail_accounts WHERE user_email = ${user.email}
  `)[0]?.gmail_address;

  // Build the RFC 2822 message. Add the X-Squideo-Deal header so server-side
  // sync (Phase 3) can thread continuity even if the recipient drops it.
  const fromName = user.name || fromAddress;
  const fromHeader = fromName && fromName !== fromAddress
    ? `${quoteHeader(fromName)} <${fromAddress}>`
    : fromAddress;
  const headers = [
    `From: ${fromHeader}`,
    `To: ${to.join(', ')}`,
    cc.length ? `Cc: ${cc.join(', ')}` : null,
    bcc.length ? `Bcc: ${bcc.join(', ')}` : null,
    `Subject: ${encodeMimeHeader(subject)}`,
    'MIME-Version: 1.0',
    dealId ? `X-Squideo-Deal: ${dealId}` : null,
  ].filter(Boolean);

  let mime;
  if (html && text) {
    const boundary = 'sqd_' + crypto.randomBytes(8).toString('hex');
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    mime = headers.join('\r\n') + '\r\n\r\n'
      + `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${text}\r\n`
      + `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${html}\r\n`
      + `--${boundary}--\r\n`;
  } else if (html) {
    headers.push('Content-Type: text/html; charset=UTF-8');
    mime = headers.join('\r\n') + '\r\n\r\n' + html;
  } else {
    headers.push('Content-Type: text/plain; charset=UTF-8');
    mime = headers.join('\r\n') + '\r\n\r\n' + text;
  }

  const raw = Buffer.from(mime, 'utf8').toString('base64url');

  const sendBody = { raw };
  if (threadId) sendBody.threadId = threadId;

  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(sendBody),
  });
  if (!sendRes.ok) {
    const errBody = await sendRes.text();
    console.error('[gmail send] failed', sendRes.status, errBody);
    return res.status(502).json({ error: `Gmail send failed (${sendRes.status})` });
  }
  const sent = await sendRes.json();

  // Log to the deal timeline so the user sees what they sent.
  if (dealId) {
    try {
      await sql`
        INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
        VALUES (
          ${dealId}, 'email_sent',
          ${JSON.stringify({
            messageId: sent.id,
            threadId: sent.threadId,
            to, cc, subject,
            fromAddress,
          })},
          ${user.email}
        )
      `;
      await sql`UPDATE deals SET last_activity_at = NOW() WHERE id = ${dealId}`;
    } catch (err) {
      console.error('[gmail send] deal_events insert failed', err);
    }
  }

  return res.status(200).json({
    ok: true,
    messageId: sent.id,
    threadId: sent.threadId,
  });
}

// Pub/Sub push receiver. Google calls this whenever the user has new Gmail
// activity. We verify the OIDC JWT, look up the account by gmail_address,
// fetch every messageAdded event since our stored historyId watermark, and
// run each one through the auto-link resolver.
async function gmailPush(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Verify Google's signed JWT. Failing this means someone is forging a
  // push — we 401 without doing any work.
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  const token = authHeader.slice(7);
  const expectedAudience = process.env.GMAIL_PUSH_AUDIENCE
    || `${APP_URL.replace(/\/$/, '')}/api/crm/gmail/push`;
  try {
    await verifyPushJwt(token, expectedAudience);
  } catch (err) {
    console.error('[gmail push] JWT verification failed', err.message);
    return res.status(401).json({ error: 'Invalid JWT' });
  }

  // Parse the Pub/Sub envelope. Always 200 so Pub/Sub doesn't retry on
  // malformed data — we'd just keep failing.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const decoded = parsePushBody(body || {});
  if (!decoded) {
    return res.status(200).json({ ok: true, skip: 'malformed' });
  }
  const { emailAddress, historyId } = decoded;

  // Find the account this notification is for.
  const accounts = await sql`
    SELECT user_email, history_id
    FROM gmail_accounts
    WHERE LOWER(gmail_address) = ${emailAddress} AND disconnected_at IS NULL
  `;
  if (!accounts.length) {
    // Could be an account that disconnected — silently ack.
    return res.status(200).json({ ok: true, skip: 'no-account' });
  }
  const account = accounts[0];

  await sql`
    UPDATE gmail_accounts SET last_pushed_at = NOW(), updated_at = NOW()
    WHERE user_email = ${account.user_email}
  `;

  // First push for this account (no watermark yet) — adopt the historyId
  // and skip processing. Future pushes will sync from here forward.
  if (!account.history_id) {
    await sql`
      UPDATE gmail_accounts SET history_id = ${historyId} WHERE user_email = ${account.user_email}
    `;
    return res.status(200).json({ ok: true, skip: 'first-push' });
  }

  // Sync all messageAdded events between our watermark and the new historyId.
  let accessToken;
  try {
    accessToken = await getFreshAccessToken(account.user_email);
  } catch (err) {
    console.error('[gmail push] token refresh failed', err.message);
    // Account is broken — ack so Pub/Sub doesn't retry forever.
    return res.status(200).json({ ok: false, error: 'token-refresh-failed' });
  }

  try {
    const result = await syncHistory({
      userEmail: account.user_email,
      accessToken,
      fromHistoryId: account.history_id,
    });
    await sql`
      UPDATE gmail_accounts SET history_id = ${result.latestHistoryId}, updated_at = NOW()
      WHERE user_email = ${account.user_email}
    `;
    return res.status(200).json({ ok: true, ingested: result.ingested, more: result.more });
  } catch (err) {
    if (err.code === 'HISTORY_GONE') {
      // Watermark fell off Gmail's history retention. Reset by re-issuing
      // the watch and adopting whatever historyId it returns.
      console.warn('[gmail push] history gone, re-issuing watch', { user: account.user_email });
      try {
        const watch = await registerWatch(accessToken, process.env.GMAIL_PUBSUB_TOPIC);
        await sql`
          UPDATE gmail_accounts SET
            history_id = ${watch.historyId},
            watch_expires_at = ${watch.expiration ? new Date(watch.expiration).toISOString() : null},
            updated_at = NOW()
          WHERE user_email = ${account.user_email}
        `;
      } catch (renewErr) {
        console.error('[gmail push] watch renew after HISTORY_GONE failed', renewErr.message);
      }
      return res.status(200).json({ ok: true, recovered: 'history-gone' });
    }
    console.error('[gmail push] sync failed', err);
    // Ack so Pub/Sub doesn't retry — the next push (or the poll-fallback
    // cron) will pick up where we left off.
    return res.status(200).json({ ok: false, error: err.message });
  }
}

// Encode a header value with RFC 2047 if it contains non-ASCII.
function encodeMimeHeader(value) {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function quoteHeader(name) {
  // Quote display names that contain special chars; otherwise leave bare.
  if (/^[\w \-.]+$/.test(name)) return name;
  return `"${name.replace(/"/g, '\\"')}"`;
}
