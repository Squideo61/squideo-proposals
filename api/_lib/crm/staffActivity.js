// Staff activity — the management view and the audit trail in one table.
//
// Two things are recorded, and only two:
//   • presence — a staff sign-in. Nothing else records one: last_login_at
//     exists on portal_users (clients) but has never existed on staff users.
//   • writes   — every non-GET that reaches the CRM router, with a field-level
//     before → after diff for the records where that's worth having.
//
// Reads are deliberately NOT logged. They'd bury the feed a hundred to one, and
// "who opened which page" isn't the question this is here to answer.
//
// Everything below is best-effort. Failing to describe a write must never fail
// the write itself, so each path swallows its own errors — loudly in the server
// log, silently to the caller.

import sql from '../db.js';

// ── table ───────────────────────────────────────────────────────────────────
let ensured = null;
export function ensureStaffActivity() {
  if (ensured) return ensured;
  ensured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS staff_activity (
        id           BIGSERIAL   PRIMARY KEY,
        actor_email  TEXT,
        action       TEXT        NOT NULL,
        entity       TEXT,
        entity_id    TEXT,
        entity_label TEXT,
        summary      TEXT        NOT NULL,
        changes      JSONB,
        meta         JSONB,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS staff_activity_time_idx ON staff_activity(created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS staff_activity_actor_idx ON staff_activity(actor_email, created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS staff_activity_entity_idx ON staff_activity(entity, entity_id, created_at DESC)`;
  })().catch((err) => {
    // Never reject: an ensure that throws takes the whole request with it, and
    // this table is a nicety. Reset so the next call retries.
    ensured = null;
    console.warn('[staff-activity] ensure failed', err.message);
  });
  return ensured;
}

// ── what gets logged ────────────────────────────────────────────────────────
// Records we diff field by field. Everything else is still logged as an action
// (who, what, when) — it just has no before → after to show.
const TRACKED = {
  deals:     { table: 'deals',       noun: 'deal' },
  companies: { table: 'companies',   noun: 'organisation' },
  contacts:  { table: 'contacts',    noun: 'contact' },
  tasks:     { table: 'tasks',       noun: 'task' },
  extras:    { table: 'deal_extras', noun: 'extra' },
};

// Machine chatter rather than someone doing something: mailbox syncs, tracking
// beacons, anything that recomputes a figure. Logging these would bury the feed.
const IGNORED_RESOURCES = new Set([
  'tracking', 'stats', 'analytics', 'sales-insights', 'resolve-client',
  'address-lookup', 'cron', 'activity',
]);

const NOUNS = {
  ...Object.fromEntries(Object.entries(TRACKED).map(([k, v]) => [k, v.noun])),
  comments: 'comment', payments: 'payment', invoices: 'invoice',
  retainers: 'retainer', templates: 'email template', folders: 'email folder',
  production: 'production record', schedule: 'schedule', commission: 'commission setting',
  voiceovers: 'voiceover artist', 'intro-calls': 'intro call', restore: 'deleted record',
  threads: 'email thread', emails: 'email', triage: 'inbox item',
  'xero-contacts': 'Xero contact', gmail: 'email',
};

const VERBS = { POST: 'created', PUT: 'updated', PATCH: 'updated', DELETE: 'deleted' };
const VERB_KEYS = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };

// Is this write worth a line in the log?
export function isLoggableWrite(resource, id, method) {
  if (!resource || !method || method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  if (IGNORED_RESOURCES.has(resource)) return false;
  // Gmail's writes are nearly all sync plumbing; sending an email is the one
  // that's a person doing something.
  if (resource === 'gmail') return id === 'send';
  return true;
}

// ── the diff ────────────────────────────────────────────────────────────────
// Columns that are noise (the write bumps them itself), secrets, or blobs.
const NEVER_DIFF = new Set([
  'id', 'created_at', 'updated_at', 'last_activity_at', 'search_vector',
  'logo', 'avatar', 'password_hash', 'totp_secret', 'backup_code_hashes',
  'token_version', 'data',
]);

const MAX_VALUE = 160;
const MAX_CHANGES = 25;

function normalise(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return '[binary]';
  if (v instanceof Uint8Array) return '[binary]';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return '[object]'; }
  }
  return String(v);
}

const clip = (s) => (s != null && s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s);

// Field-level before → after for one row, as [{ field, from, to }].
export function diffRows(before, after) {
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].sort();
  const out = [];
  for (const field of keys) {
    if (NEVER_DIFF.has(field)) continue;
    const from = normalise(before?.[field]);
    const to = normalise(after?.[field]);
    if (from === to) continue;
    // A blob that changed says nothing useful and can't be rendered.
    if (from === '[binary]' || to === '[binary]') continue;
    out.push({ field, from: clip(from), to: clip(to) });
    if (out.length >= MAX_CHANGES) break;
  }
  return out;
}

// ── describing a write ──────────────────────────────────────────────────────
const humanise = (s) => String(s || '').replace(/[-_]/g, ' ').trim();

// A name for the record, so a line still reads properly after it's deleted.
function labelFor(resource, row, body) {
  const pick = (...vals) => vals.map((v) => (typeof v === 'string' ? v.trim() : v)).find(Boolean) || null;
  if (resource === 'contacts') return pick(row?.name, row?.email, body?.name, body?.email);
  if (resource === 'companies') return pick(row?.name, body?.name);
  if (resource === 'extras') return pick(row?.description, body?.description);
  return pick(row?.title, row?.name, row?.description, body?.title, body?.name, body?.description);
}

// { action, entity, entityLabel, summary } for one CRM write. Pure — the router
// hands it the rows it already fetched.
export function describeWrite({ resource, id, action, method, body, before, result }) {
  const verb = VERBS[method] || 'changed';
  const verbKey = VERB_KEYS[method] || 'change';
  const noun = NOUNS[resource] || humanise(resource);

  if (resource === 'gmail' && id === 'send') {
    const to = Array.isArray(body?.to) ? body.to.join(', ') : body?.to;
    return {
      action: 'gmail.send',
      entity: 'email',
      entityLabel: (body?.subject || to || null),
      summary: to ? `sent an email to ${to}` : 'sent an email',
    };
  }
  if (resource === 'restore') {
    return { action: 'restore.create', entity: 'restore', entityLabel: null, summary: 'restored a deleted record' };
  }

  // A sub-route (/deals/:id/stage) names what was touched; a bare id doesn't.
  const sub = action && action !== 'detail' ? humanise(action) : null;
  return {
    action: [resource, action || null, verbKey].filter(Boolean).join('.'),
    entity: resource,
    // A create has no row to read yet, so its name comes from what came back
    // (or, failing that, what was sent).
    entityLabel: labelFor(resource, before || result, body),
    summary: sub ? `${verb} ${noun} ${sub}` : `${verb} ${noun}`,
  };
}

// ── snapshots ───────────────────────────────────────────────────────────────
// Explicit per-table queries rather than a dynamic table name: the set is small
// and this way no request can steer what gets read.
async function snapshot(resource, id) {
  if (!TRACKED[resource] || !id) return null;
  try {
    switch (resource) {
      case 'deals':     return (await sql`SELECT * FROM deals WHERE id = ${id}`)[0] || null;
      case 'companies': return (await sql`SELECT * FROM companies WHERE id = ${id}`)[0] || null;
      case 'contacts':  return (await sql`SELECT * FROM contacts WHERE id = ${id}`)[0] || null;
      case 'tasks':     return (await sql`SELECT * FROM tasks WHERE id = ${id}`)[0] || null;
      case 'extras':    return (await sql`SELECT * FROM deal_extras WHERE id = ${id}`)[0] || null;
      default: return null;
    }
  } catch {
    return null; // the diff is a bonus; never let it break the write
  }
}

// ── writing a line ──────────────────────────────────────────────────────────
export async function logStaffActivity({
  actorEmail, action, entity = null, entityId = null, entityLabel = null,
  summary, changes = null, meta = null,
}) {
  if (!action || !summary) return;
  try {
    await ensureStaffActivity();
    // The same action on the same record, again, within ten minutes — a builder
    // auto-saving, a schedule block being dragged about — moves the line that's
    // already there instead of adding another. Only when there's no diff to
    // lose: a change with before → after values is always worth its own line.
    if (!changes || !changes.length) {
      const [recent] = await sql`
        SELECT id FROM staff_activity
         WHERE actor_email IS NOT DISTINCT FROM ${actorEmail || null}
           AND action = ${action}
           AND entity_id IS NOT DISTINCT FROM ${entityId}
           AND created_at > NOW() - INTERVAL '10 minutes'
         ORDER BY created_at DESC LIMIT 1
      `;
      if (recent) {
        await sql`UPDATE staff_activity SET created_at = NOW() WHERE id = ${recent.id}`;
        return;
      }
    }
    await sql`
      INSERT INTO staff_activity (actor_email, action, entity, entity_id, entity_label, summary, changes, meta)
      VALUES (${actorEmail || null}, ${action}, ${entity}, ${entityId}, ${clip(entityLabel)}, ${summary},
              ${changes && changes.length ? JSON.stringify(changes) : null}::jsonb,
              ${meta ? JSON.stringify(meta) : null}::jsonb)
    `;
  } catch (err) {
    console.warn('[staff-activity] log failed', err.message);
  }
}

// ── the router hooks ────────────────────────────────────────────────────────
// Called BEFORE the handler runs: takes the "before" snapshot while the record
// still says what it said. Returns null when there's nothing to log, which is
// the cheap path for every read.
export async function beginWrite({ resource, id, action, method }) {
  if (!isLoggableWrite(resource, id, method)) return null;
  const before = await snapshot(resource, id);
  return { resource, id, action, method, before };
}

// Called after the handler has responded. The response is already flushed, so
// the extra queries here cost the caller nothing.
export async function finishWrite(pending, { statusCode, actorEmail, body, result, req }) {
  if (!pending) return;
  // A rejected write didn't happen — logging it as an action would be a lie.
  if (statusCode == null || statusCode >= 400) return;
  const { resource, id, action, method, before } = pending;

  const after = method === 'DELETE' ? null : await snapshot(resource, id);
  // On a delete every field would read "→ nothing"; the line itself says it.
  const changes = method === 'DELETE' ? [] : diffRows(before, after);

  // A create posts to the collection, so the id only exists in the response.
  const created = !id && result && typeof result === 'object' && typeof result.id === 'string' ? result.id : null;
  const described = describeWrite({ resource, id, action, method, body, before: before || after, result });
  await logStaffActivity({
    actorEmail,
    ...described,
    // gmail's "id" is the sub-action (send), not a record.
    entityId: resource === 'gmail' ? null : (id || created || null),
    changes,
    meta: {
      method,
      path: (req?.url || '').split('?')[0] || null,
      ip: clientIp(req),
    },
  });
}

function clientIp(req) {
  const fwd = req?.headers?.['x-forwarded-for'];
  if (!fwd) return null;
  return String(fwd).split(',')[0].trim() || null;
}

// ── retention ───────────────────────────────────────────────────────────────
// Twelve months matches how long proposal views are kept. Long enough to answer
// "who changed this", short enough that the table never becomes a cost.
export async function pruneStaffActivity() {
  try {
    await ensureStaffActivity();
    const r = await sql`DELETE FROM staff_activity WHERE created_at < NOW() - INTERVAL '12 months'`;
    return r.count || r.rowCount || 0;
  } catch (err) {
    console.warn('[staff-activity] prune failed', err.message);
    return 0;
  }
}

// ── reading it back ─────────────────────────────────────────────────────────
function serialise(r) {
  return {
    id: String(r.id),
    at: r.created_at,
    actorEmail: r.actor_email || null,
    actorName: r.actor_name || null,
    action: r.action,
    entity: r.entity || null,
    entityId: r.entity_id || null,
    entityLabel: r.entity_label || null,
    summary: r.summary,
    changes: Array.isArray(r.changes) ? r.changes : [],
    meta: r.meta || {},
  };
}

export async function staffActivityFeed({ since, actor = null, entity = null, before = null, limit = 100 }) {
  await ensureStaffActivity();
  const rows = await sql`
    SELECT a.id, a.actor_email, a.action, a.entity, a.entity_id, a.entity_label,
           a.summary, a.changes, a.meta, a.created_at, u.name AS actor_name
      FROM staff_activity a
      LEFT JOIN users u ON u.email = a.actor_email
     WHERE a.created_at >= ${since}
       AND (${actor}::text IS NULL OR a.actor_email = ${actor})
       AND (${entity}::text IS NULL OR a.entity = ${entity})
       AND (${before}::timestamptz IS NULL OR a.created_at < ${before})
     ORDER BY a.created_at DESC
     LIMIT ${Math.min(Number(limit) || 100, 200)}
  `.catch((err) => { console.warn('[staff-activity] feed failed', err.message); return []; });
  return rows.map(serialise);
}

// Per-person totals for the period — the "how busy is everyone" half of the
// view. Two grouped queries merged in JS beats one query per person.
export async function staffActivitySummary({ since }) {
  await ensureStaffActivity();
  const [totals, byEntity] = await Promise.all([
    sql`
      SELECT a.actor_email,
             COUNT(*)::int AS actions,
             COUNT(DISTINCT ((a.created_at AT TIME ZONE 'Europe/London')::date))::int AS active_days,
             MAX(a.created_at) AS last_at,
             COUNT(*) FILTER (WHERE a.action = 'auth.login')::int AS logins,
             u.name AS actor_name
        FROM staff_activity a
        LEFT JOIN users u ON u.email = a.actor_email
       WHERE a.created_at >= ${since}
       GROUP BY a.actor_email, u.name
       ORDER BY actions DESC
    `.catch(() => []),
    sql`
      SELECT actor_email, COALESCE(entity, 'other') AS entity, COUNT(*)::int AS n
        FROM staff_activity
       WHERE created_at >= ${since} AND action <> 'auth.login'
       GROUP BY 1, 2
    `.catch(() => []),
  ]);

  const areas = new Map();
  for (const r of byEntity) {
    const list = areas.get(r.actor_email) || [];
    list.push({ entity: r.entity, count: r.n });
    areas.set(r.actor_email, list);
  }
  return totals.map((t) => ({
    email: t.actor_email || null,
    name: t.actor_name || null,
    actions: t.actions,
    activeDays: t.active_days,
    logins: t.logins,
    lastAt: t.last_at,
    areas: (areas.get(t.actor_email) || []).sort((a, b) => b.count - a.count).slice(0, 4),
  }));
}

// ── GET /api/crm/activity ───────────────────────────────────────────────────
export async function staffActivityRoute(req, res, id, action, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  const days = Math.min(Math.max(Number(req.query?.days) || 7, 1), 365);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const actor = (req.query?.actor || '').trim() || null;
  const entity = (req.query?.entity || '').trim() || null;
  // The paging cursor is a timestamp from a row we already sent; anything else
  // would just be a cast error inside the query.
  const cursor = (req.query?.before || '').trim();
  const before = cursor && !Number.isNaN(Date.parse(cursor)) ? new Date(cursor).toISOString() : null;

  const [items, people] = await Promise.all([
    staffActivityFeed({ since, actor, entity, before }),
    // The per-person totals describe the whole period, so they don't change as
    // the feed pages backwards.
    before ? Promise.resolve(null) : staffActivitySummary({ since }),
  ]);

  return res.status(200).json({ days, items, ...(people ? { people } : {}) });
}
