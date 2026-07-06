// Producer scheduling calendar + annual leave.
//
// Endpoints (all under /api/crm/schedule, dispatched from api/crm/[...slug].js):
//   GET    /api/crm/schedule                 — calendar data (master for managers,
//                                              own-only for producers)
//   POST   /api/crm/schedule/sync            — regenerate a deal's calendar blocks
//   PATCH  /api/crm/schedule/assignment/:id  — move / extend / reassign a block
//   DELETE /api/crm/schedule/assignment/:id  — remove a block
//   POST   /api/crm/schedule/leave           — book annual leave (→ managers approve)
//   PATCH  /api/crm/schedule/leave/:id       — approve / deny (managers)
//   DELETE /api/crm/schedule/leave/:id       — cancel own request
//   PATCH  /api/crm/schedule/allowance/:email— edit a member's allowance (managers)
//
// The greedy scheduler (syncDealSchedule) places each video's storyboard and
// production blocks in the assigned producer's next free run of working days,
// aiming to finish an internal-review buffer ahead of the delivery deadline.
// A block that can't fit before the deadline is flagged `conflict` and the
// managers (Admins + Directors) are notified for manual review.

import sql from '../db.js';
import { makeId, trimOrNull } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { sendNotification } from '../notifications.js';
import { APP_URL } from '../email.js';
import {
  durationDaysForLength, workingDaysBetween, addWorkingDays, addDays,
  nextWorkingDay, todayStr, countWorkingDays,
} from '../scheduleCalendar.js';

// Finish work at least this many working days before the client delivery date,
// so it can be checked internally first.
const INTERNAL_REVIEW_BUFFER_DAYS = 1;

// ── Schema self-heal (mirrors db/migrations/20260703_producer_schedule.sql) ──
let schemaReady = null;
export function ensureScheduleTables() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await sql`CREATE TABLE IF NOT EXISTS schedule_assignments (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      deal_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      duration_days INTEGER NOT NULL DEFAULT 1,
      extended_days INTEGER NOT NULL DEFAULT 0,
      auto_generated BOOLEAN NOT NULL DEFAULT TRUE,
      conflict BOOLEAN NOT NULL DEFAULT FALSE,
      conflict_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS schedule_assignments_video_kind_user_uidx
      ON schedule_assignments (video_id, kind, user_email)`;
    await sql`CREATE INDEX IF NOT EXISTS schedule_assignments_user_idx ON schedule_assignments (user_email)`;
    await sql`CREATE INDEX IF NOT EXISTS schedule_assignments_deal_idx ON schedule_assignments (deal_id)`;
    await sql`CREATE TABLE IF NOT EXISTS leave_requests (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      days NUMERIC NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'annual',
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      decided_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS leave_requests_user_idx ON leave_requests (user_email)`;
    await sql`CREATE TABLE IF NOT EXISTS leave_allowances (
      user_email TEXT PRIMARY KEY,
      annual_allowance NUMERIC NOT NULL DEFAULT 20,
      compulsory_days NUMERIC NOT NULL DEFAULT 6,
      anniversary DATE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      track_allowance BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    // `active` = on the schedule roster (calendar column + can enter days off).
    // `track_allowance` = show an annual-leave allowance + count leave against it.
    // Directors/owners who produce sit active=true, track_allowance=false.
    await sql`ALTER TABLE leave_allowances ADD COLUMN IF NOT EXISTS track_allowance BOOLEAN NOT NULL DEFAULT TRUE`;
  })().catch((err) => { schemaReady = null; throw err; });
  return schemaReady;
}

function asDateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
function laterDate(a, b) {
  if (!a) return b; if (!b) return a;
  return a > b ? a : b;
}
// hasPermission takes a single slug; check any-of by hand.
function roleHasAny(role, slugs) {
  return slugs.some(s => hasPermission(role, s));
}
async function canManage(user) {
  return hasPermission(await getRole(user.role), 'schedule.manage');
}
async function canApproveLeave(user) {
  return hasPermission(await getRole(user.role), 'schedule.approve_leave');
}
// Every user eligible for the schedule (role has schedule.access, or is an
// admin via the '*' wildcard), each annotated with their leave_allowances flags.
//   onRoster  = shown as a calendar column / assignable / can enter days off.
//               Defaults ON for non-admins, OFF for admins; the `active` flag
//               overrides either way (so an admin can be opted in, a director
//               opted out).
//   trackAllowance = has an annual-leave allowance counted in the tracker.
async function scheduleUsers() {
  const rows = await sql`
    SELECT u.email, u.name, u.avatar,
           (r.permissions @> '["*"]'::jsonb) AS is_admin,
           la.active AS active, la.track_allowance AS track_allowance
      FROM users u
      JOIN roles r ON r.id = u.role
      LEFT JOIN leave_allowances la ON la.user_email = u.email
     WHERE r.permissions @> '["schedule.access"]'::jsonb OR r.permissions @> '["*"]'::jsonb
     ORDER BY u.name NULLS LAST, u.email`;
  return rows.map(r => {
    const isAdmin = !!r.is_admin;
    const onRoster = (r.active == null ? !isAdmin : r.active) === true;
    return {
      email: String(r.email).toLowerCase(),
      name: r.name || r.email,
      avatar: r.avatar || null,
      isAdmin,
      hasRow: r.active != null || r.track_allowance != null,
      active: r.active,
      trackAllowance: r.track_allowance !== false, // null (no row) → true
      onRoster,
    };
  });
}
// Just the roster (calendar columns / assignable people).
async function teamMembers() {
  return (await scheduleUsers()).filter(u => u.onRoster).map(u => ({ email: u.email, name: u.name, avatar: u.avatar }));
}

// ── Deadlines from the deal's production schedule JSON ──
function scheduleDeadlines(schedule) {
  let storyboard = null, production = null;
  for (const sec of schedule?.sections || []) {
    if (sec && sec.enabled === false) continue;
    for (const row of sec?.rows || []) {
      if (row && row.enabled === false) continue;
      if (row?.id === 'storyboard' && row.deliveredBy) storyboard = asDateStr(row.deliveredBy);
      if (row?.id === 'video' && row.deliveredBy) production = asDateStr(row.deliveredBy);
    }
  }
  return { storyboard, production };
}

// ── The greedy packer ──
// Earliest run of `n` free working days for a producer, starting no earlier
// than `earliestStr`, avoiding the `occupied` day set. Returns the array of day
// strings, or null if nothing found within the guard window.
function firstFreeRun(occupied, n, earliestStr) {
  let day = nextWorkingDay(earliestStr);
  let guard = 0;
  while (guard++ < 2000) {
    const run = [];
    let d = day;
    let blockedAt = null;
    while (run.length < n) {
      d = nextWorkingDay(d);
      if (occupied.has(d)) { blockedAt = d; break; }
      run.push(d);
      d = addDays(d, 1);
    }
    if (run.length === n) return run;
    day = nextWorkingDay(addDays(blockedAt, 1));
  }
  return null;
}

// Build each producer's occupied working-day set from existing (kept) blocks +
// pending/approved leave. Auto blocks of the deal being resynced are excluded —
// they're about to be replaced.
async function loadOccupancy(emails, excludeDealId) {
  const map = new Map(emails.map(e => [e, new Set()]));
  if (!emails.length) return map;
  const asg = await sql`SELECT user_email, start_date, end_date, deal_id, auto_generated
    FROM schedule_assignments WHERE user_email = ANY(${emails})`;
  for (const a of asg) {
    if (a.deal_id === excludeDealId && a.auto_generated) continue;
    const set = map.get(String(a.user_email).toLowerCase());
    if (!set) continue;
    for (const d of workingDaysBetween(asDateStr(a.start_date), asDateStr(a.end_date))) set.add(d);
  }
  const lv = await sql`SELECT user_email, start_date, end_date FROM leave_requests
    WHERE user_email = ANY(${emails}) AND status IN ('pending','approved')`;
  for (const l of lv) {
    const set = map.get(String(l.user_email).toLowerCase());
    if (!set) continue;
    for (const d of workingDaysBetween(asDateStr(l.start_date), asDateStr(l.end_date))) set.add(d);
  }
  return map;
}

// Regenerate a deal's auto calendar blocks. Manual (dragged/extended) blocks are
// preserved and treated as fixed occupancy. Returns { blocks, conflicts }.
export async function syncDealSchedule(dealId, { notify = true } = {}) {
  await ensureScheduleTables();
  const [deal] = await sql`SELECT id, title, production_schedule, production_start_date
    FROM deals WHERE id = ${dealId}`;
  if (!deal) return { blocks: 0, conflicts: 0 };
  const deadlines = scheduleDeadlines(deal.production_schedule);
  const floor = laterDate(todayStr(), asDateStr(deal.production_start_date));

  const videos = await sql`SELECT pv.id, pv.title, pv.video_length,
      (SELECT COALESCE(ARRAY_AGG(va.user_email ORDER BY va.assigned_at), '{}')
         FROM video_assignees va WHERE va.video_id = pv.id) AS producer_emails
    FROM project_videos pv
    WHERE pv.deal_id = ${dealId} AND pv.production_phase IS NOT NULL
    ORDER BY pv.sort_order, pv.created_at`;

  const existing = await sql`SELECT * FROM schedule_assignments WHERE deal_id = ${dealId}`;
  const existingByKey = new Map(existing.map(r => [`${r.video_id}:${r.kind}`, r]));
  const existingByFullKey = new Map(existing.map(r => [`${r.video_id}:${r.kind}:${String(r.user_email).toLowerCase()}`, r]));

  // Per-stage producers assigned on the Production Schedule (storyboard /
  // production). These win over the video's own assignee so Callum can route
  // each stage to a specific producer. Fall back to the video assignee.
  const schedProducers = (deal.production_schedule && deal.production_schedule.producers) || {};
  const stageProducer = (kind, video) => {
    const fromSchedule = schedProducers[kind] ? String(schedProducers[kind]).toLowerCase() : null;
    const fromVideo = (video.producer_emails || []).map(e => String(e).toLowerCase()).filter(Boolean)[0] || null;
    return fromSchedule || fromVideo;
  };

  const producerEmails = [...new Set([
    ...videos.flatMap(v => (v.producer_emails || []).map(e => String(e).toLowerCase())),
    ...['storyboard', 'production'].map(k => schedProducers[k] ? String(schedProducers[k]).toLowerCase() : null),
  ].filter(Boolean))];
  const occupancy = await loadOccupancy(producerEmails, dealId);

  const touchedIds = new Set();    // row ids we (re)generated or preserved
  const newConflicts = [];         // blocks that newly became conflicting

  const STAGES = [
    { kind: 'storyboard', deadline: deadlines.storyboard },
    { kind: 'production', deadline: deadlines.production },
  ];

  const occupiedFor = (email) => {
    if (!occupancy.has(email)) occupancy.set(email, new Set());
    return occupancy.get(email);
  };

  for (const v of videos) {
    const baseDays = durationDaysForLength(v.video_length);

    let prevEnd = null; // production must follow storyboard for the same video
    for (const stage of STAGES) {
      // Preserve a hand-edited block for this (video, stage) as-is — respects a
      // manual move / extend / reassign. Keep its days occupied and chain off it.
      const priorAny = existingByKey.get(`${v.id}:${stage.kind}`);
      if (priorAny && priorAny.auto_generated === false) {
        touchedIds.add(priorAny.id);
        for (const d of workingDaysBetween(asDateStr(priorAny.start_date), asDateStr(priorAny.end_date))) {
          occupiedFor(String(priorAny.user_email).toLowerCase()).add(d);
        }
        prevEnd = asDateStr(priorAny.end_date);
        continue;
      }

      const producer = stageProducer(stage.kind, v);
      if (!producer) continue; // nobody assigned for this stage → skip
      const occupied = occupiedFor(producer);
      const earliest = stage.kind === 'production' && prevEnd
        ? nextWorkingDay(addDays(prevEnd, 1))
        : floor;
      const run = firstFreeRun(occupied, baseDays, earliest);
      if (!run) continue;
      const start = run[0];
      const end = run[run.length - 1];
      for (const d of run) occupied.add(d);
      prevEnd = end;

      // Conflict: finished later than (deadline − internal-review buffer)?
      let conflict = false, reason = null;
      if (stage.deadline) {
        const latestSafeEnd = addWorkingDays(stage.deadline, -INTERNAL_REVIEW_BUFFER_DAYS);
        if (end > latestSafeEnd) {
          conflict = true;
          reason = end > stage.deadline
            ? `Work finishes ${end}, after the ${stage.deadline} delivery date.`
            : `Work finishes ${end}, leaving no internal-review buffer before the ${stage.deadline} delivery date.`;
        }
      }
      // Reuse the same row only when it's the same (video, kind, producer) — a
      // changed producer means a fresh row (the old one is cleaned up below).
      const sameKeyPrior = existingByFullKey.get(`${v.id}:${stage.kind}:${producer}`);
      const wasConflict = sameKeyPrior ? !!sameKeyPrior.conflict : false;
      if (conflict && !wasConflict) newConflicts.push({ video: v, stage, producer, start, end, reason });

      const id = sameKeyPrior?.id || makeId('sched');
      await sql`INSERT INTO schedule_assignments
          (id, video_id, deal_id, user_email, kind, start_date, end_date, duration_days, extended_days, auto_generated, conflict, conflict_reason, updated_at)
        VALUES (${id}, ${v.id}, ${dealId}, ${producer}, ${stage.kind}, ${start}, ${end}, ${baseDays}, 0, TRUE, ${conflict}, ${reason}, NOW())
        ON CONFLICT (video_id, kind, user_email) DO UPDATE SET
          start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
          duration_days = EXCLUDED.duration_days, deal_id = EXCLUDED.deal_id,
          extended_days = 0, auto_generated = TRUE, conflict = EXCLUDED.conflict,
          conflict_reason = EXCLUDED.conflict_reason, updated_at = NOW()`;
      touchedIds.add(id);
    }
  }

  // Remove auto blocks that no longer apply (assignee removed/changed, video
  // dropped from the board, etc.). Hand-edited blocks are never auto-deleted.
  for (const r of existing) {
    if (r.auto_generated && !touchedIds.has(r.id)) {
      await sql`DELETE FROM schedule_assignments WHERE id = ${r.id}`;
    }
  }

  if (notify && newConflicts.length) {
    try { await notifyConflicts(deal, newConflicts); }
    catch (err) { console.warn('[schedule] conflict notify failed', err.message); }
  }
  return { blocks: touchedIds.size, conflicts: newConflicts.length };
}

async function notifyConflicts(deal, conflicts) {
  const title = deal.title || deal.id;
  const lines = conflicts.map(c =>
    `• ${title} — ${c.video.title || 'Video'} (${c.stage.kind}) for ${c.producer}: ${c.reason}`);
  const link = `#/schedule`;
  await sendNotification('schedule.conflict', {
    subject: `⚠️ Schedule clash: ${title}`,
    html: `<p style="font-size:15px">A production block can't fit before its delivery date — please review the schedule.</p>`
        + `<ul>${conflicts.map(c => `<li>${c.video.title || 'Video'} (${c.stage.kind}) — ${c.reason}</li>`).join('')}</ul>`
        + `<p><a href="${APP_URL}/#/schedule">Open the schedule</a></p>`,
    text: `Schedule clash on ${title}:\n${lines.join('\n')}\n${APP_URL}/#/schedule`,
    inApp: { title: `Schedule clash: ${title}`, body: conflicts[0].reason, link, tag: `sched-conflict-${deal.id}` },
  });
}

// ── Leave-year maths ──
function leaveYearWindow(anniversary, today) {
  // Window [start, nextStart) anchored on the joining anniversary. Falls back to
  // the calendar year when no anniversary is on file.
  const t = today || todayStr();
  if (!anniversary) {
    const y = t.slice(0, 4);
    return { start: `${y}-01-01`, next: `${+y + 1}-01-01` };
  }
  const mmdd = asDateStr(anniversary).slice(5); // MM-DD
  const y = +t.slice(0, 4);
  let start = `${y}-${mmdd}`;
  if (t < start) start = `${y - 1}-${mmdd}`;
  const next = `${+start.slice(0, 4) + 1}-${mmdd}`;
  return { start, next };
}

// ── Serialisers ──
function serialiseAssignment(r, ctx) {
  const start = asDateStr(r.start_date);
  const end = asDateStr(r.end_date);
  const today = ctx.today;
  const daysUntilStart = start >= today ? countWorkingDays(today, start) - 1 : -(countWorkingDays(start, today) - 1);
  const approved = ctx.milestones.get(r.video_id) || new Set();
  const ready = r.kind === 'storyboard' ? approved.has('script') : approved.has('storyboard');
  // Leave booked over this block after it was placed → live clash.
  const leaveDays = ctx.leaveByUser.get(String(r.user_email).toLowerCase()) || new Set();
  const leaveConflict = workingDaysBetween(start, end).some(d => leaveDays.has(d));
  return {
    id: r.id,
    videoId: r.video_id,
    dealId: r.deal_id,
    userEmail: String(r.user_email).toLowerCase(),
    kind: r.kind,
    startDate: start,
    endDate: end,
    durationDays: r.duration_days,
    extendedDays: r.extended_days,
    autoGenerated: r.auto_generated,
    conflict: !!r.conflict,
    conflictReason: r.conflict_reason || null,
    leaveConflict,
    ready,
    daysUntilStart,
    projectTitle: ctx.videoMeta.get(r.video_id)?.projectTitle || null,
    videoTitle: ctx.videoMeta.get(r.video_id)?.title || null,
    videoLength: ctx.videoMeta.get(r.video_id)?.videoLength || null,
    productionStage: ctx.videoMeta.get(r.video_id)?.stage || null,
  };
}

function serialiseLeave(r) {
  return {
    id: r.id,
    userEmail: String(r.user_email).toLowerCase(),
    startDate: asDateStr(r.start_date),
    endDate: asDateStr(r.end_date),
    days: Number(r.days),
    kind: r.kind,
    note: r.note || null,
    status: r.status,
    decidedBy: r.decided_by || null,
    decidedAt: r.decided_at || null,
    createdAt: r.created_at,
  };
}

// ── The GET payload ──
async function buildPayload(user, manage, approve = false) {
  const email = (user.email || '').toLowerCase();
  const today = todayStr();
  const candidates = await scheduleUsers();
  const roster = candidates.filter(u => u.onRoster).map(u => ({ email: u.email, name: u.name, avatar: u.avatar }));
  const scopeEmails = manage ? roster.map(m => m.email) : [email];

  // Assignments
  const asg = scopeEmails.length
    ? await sql`SELECT * FROM schedule_assignments WHERE user_email = ANY(${scopeEmails}) ORDER BY start_date`
    : [];
  const videoIds = [...new Set(asg.map(a => a.video_id))];
  const videoMeta = new Map();
  const milestones = new Map();
  if (videoIds.length) {
    const vids = await sql`SELECT pv.id, pv.title, pv.video_length, pv.production_stage, d.title AS project_title
      FROM project_videos pv JOIN deals d ON d.id = pv.deal_id WHERE pv.id = ANY(${videoIds})`;
    for (const v of vids) videoMeta.set(v.id, { title: v.title, videoLength: v.video_length, stage: v.production_stage, projectTitle: v.project_title });
    const ms = await sql`SELECT video_id, milestone FROM video_milestones WHERE video_id = ANY(${videoIds})`;
    for (const m of ms) {
      if (!milestones.has(m.video_id)) milestones.set(m.video_id, new Set());
      milestones.get(m.video_id).add(m.milestone);
    }
  }

  // Leave
  const leave = scopeEmails.length
    ? await sql`SELECT * FROM leave_requests WHERE user_email = ANY(${scopeEmails}) ORDER BY start_date DESC`
    : [];
  const leaveByUser = new Map();
  for (const l of leave) {
    if (l.status === 'denied') continue;
    const key = String(l.user_email).toLowerCase();
    if (!leaveByUser.has(key)) leaveByUser.set(key, new Set());
    for (const d of workingDaysBetween(asDateStr(l.start_date), asDateStr(l.end_date))) leaveByUser.get(key).add(d);
  }

  const ctx = { today, videoMeta, milestones, leaveByUser };
  const assignments = asg.map(a => serialiseAssignment(a, ctx));

  // Allowances (self-provision a row per roster member on demand)
  const allowances = await buildAllowances(candidates, manage ? null : email, today);

  // Amends-to-do: videos currently in a revisions stage, mapped to their producer.
  const amends = await buildAmends(scopeEmails, manage);

  return {
    canManage: manage,
    canApproveLeave: approve,
    me: email,
    // Managers see the whole active roster on the master calendar; a producer
    // only needs (and only gets) their own row.
    producers: manage ? roster : roster.filter(m => m.email === email),
    assignments,
    leave: leave.map(serialiseLeave),
    allowances,
    amends,
  };
}

// `candidates` are scheduleUsers() rows. Provisions an allowance row for roster
// members lacking one, then returns one entry per person who is either on the
// roster or has an explicit row (so removed people still surface for re-adding).
// `onlyEmail` scopes to a single person (non-manager view).
async function buildAllowances(candidates, onlyEmail, today) {
  let pool = candidates;
  if (onlyEmail) pool = candidates.filter(c => c.email === onlyEmail);
  if (!pool.length) return [];

  // Provision a default row for roster members who don't have one yet.
  const missing = pool.filter(c => c.onRoster && !c.hasRow).map(c => c.email);
  if (missing.length) {
    const joins = await sql`SELECT email, created_at FROM users WHERE email = ANY(${missing})`;
    const joinMap = new Map(joins.map(j => [String(j.email).toLowerCase(), asDateStr(j.created_at)]));
    for (const e of missing) {
      await sql`INSERT INTO leave_allowances (user_email, anniversary) VALUES (${e}, ${joinMap.get(e) || null})
        ON CONFLICT (user_email) DO NOTHING`;
    }
  }
  const rows = await sql`SELECT * FROM leave_allowances WHERE user_email = ANY(${pool.map(c => c.email)})`;
  const rowByEmail = new Map(rows.map(r => [String(r.user_email).toLowerCase(), r]));

  const out = [];
  for (const c of pool) {
    const r = rowByEmail.get(c.email);
    if (!c.onRoster && !r) continue; // admins with no row aren't shown at all
    const allowance = r ? Number(r.annual_allowance) : 20;
    const compulsory = r ? Number(r.compulsory_days) : 6;
    const track = r ? r.track_allowance !== false : true;
    const win = leaveYearWindow(r?.anniversary, today);
    let taken = 0, remaining = null;
    if (track) {
      const [t] = await sql`SELECT COALESCE(SUM(days),0) AS d FROM leave_requests
        WHERE user_email = ${c.email} AND status = 'approved' AND kind = 'annual'
          AND start_date >= ${win.start} AND start_date < ${win.next}`;
      taken = Number(t?.d || 0);
      remaining = Math.round((allowance - compulsory - taken) * 10) / 10;
    }
    out.push({
      userEmail: c.email,
      name: c.name,
      isAdmin: c.isAdmin,
      onRoster: c.onRoster,
      trackAllowance: track,
      annualAllowance: allowance,
      compulsoryDays: compulsory,
      anniversary: r?.anniversary ? asDateStr(r.anniversary) : null,
      taken,
      remaining,
      renewal: win.next,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function buildAmends(scopeEmails, manage) {
  if (!scopeEmails.length) return [];
  // amends_1 = storyboard revisions, amends_2 = revisions after production.
  // Resolve the owning producer from (in priority) the Production Schedule's
  // per-stage producer, the video's assignees, its legacy producer_email, then
  // the deal's assignees — so a project assigned any of those ways still lands
  // in the right producer's Amends-to-do list.
  const rows = await sql`SELECT pv.id, pv.title, pv.production_stage, pv.production_stage_changed_at,
      pv.producer_email AS legacy_producer, d.id AS deal_id, d.title AS project_title,
      d.production_schedule AS production_schedule,
      (SELECT COALESCE(ARRAY_AGG(va.user_email), '{}') FROM video_assignees va WHERE va.video_id = pv.id) AS video_producers,
      (SELECT COALESCE(ARRAY_AGG(da.user_email), '{}') FROM deal_assignees da WHERE da.deal_id = d.id) AS deal_producers
    FROM project_videos pv JOIN deals d ON d.id = pv.deal_id
    WHERE pv.production_stage IN ('amends_1','amends_2')
    ORDER BY pv.production_stage_changed_at DESC NULLS LAST`;
  const out = [];
  for (const r of rows) {
    const sp = (r.production_schedule && r.production_schedule.producers) || {};
    const revisionsProducer = sp.revisions ? String(sp.revisions).toLowerCase() : null;
    const stageProducer = r.production_stage === 'amends_1'
      ? (sp.storyboard ? String(sp.storyboard).toLowerCase() : null)
      : (sp.production ? String(sp.production).toLowerCase() : null);
    const producers = [...new Set([
      revisionsProducer, stageProducer,
      ...(r.video_producers || []).map(e => String(e).toLowerCase()),
      r.legacy_producer ? String(r.legacy_producer).toLowerCase() : null,
      ...(r.deal_producers || []).map(e => String(e).toLowerCase()),
    ].filter(Boolean))];
    const owner = producers[0] || null;
    if (!manage) {
      const mine = producers.some(p => scopeEmails.includes(p));
      if (!mine) continue;
    }
    out.push({
      videoId: r.id,
      dealId: r.deal_id,
      projectTitle: r.project_title,
      videoTitle: r.title,
      kind: r.production_stage === 'amends_1' ? 'storyboard' : 'video',
      stage: r.production_stage,
      userEmail: owner,
      producerEmails: producers,
      since: r.production_stage_changed_at || null,
    });
  }
  return out;
}

// ── Route ──
export async function scheduleRoute(req, res, id, action, user) {
  if (!roleHasAny(await getRole(user.role), ['schedule.access', 'schedule.manage', 'schedule.approve_leave'])) {
    return res.status(403).json({ error: 'You do not have access to the schedule' });
  }
  await ensureScheduleTables();
  const role = await getRole(user.role);
  const manage = hasPermission(role, 'schedule.manage');
  const approve = hasPermission(role, 'schedule.approve_leave');
  const email = (user.email || '').toLowerCase();
  const reload = () => buildPayload(user, manage, approve);

  // GET /api/crm/schedule
  if (!id) {
    if (req.method === 'GET') return res.status(200).json(await reload());
    return res.status(405).end();
  }

  // POST /api/crm/schedule/sync { dealId }
  if (id === 'sync') {
    if (req.method !== 'POST') return res.status(405).end();
    const dealId = trimOrNull((req.body || {}).dealId);
    if (!dealId) return res.status(400).json({ error: 'dealId is required' });
    const result = await syncDealSchedule(dealId);
    return res.status(200).json({ ...result, ...(await reload()) });
  }

  // /api/crm/schedule/assignment/:aid
  if (id === 'assignment') {
    const aid = action;
    if (!aid) return res.status(400).json({ error: 'assignment id required' });
    const [row] = await sql`SELECT * FROM schedule_assignments WHERE id = ${aid}`;
    if (!row) return res.status(404).json({ error: 'Not found' });
    // A producer may move their own blocks; managers may move anyone's.
    if (!manage && String(row.user_email).toLowerCase() !== email) {
      return res.status(403).json({ error: 'Not your block' });
    }
    if (req.method === 'PATCH') {
      const b = req.body || {};
      let { start_date, end_date, duration_days, user_email } = row;
      let startStr = asDateStr(start_date);
      let dur = row.duration_days;
      if (b.startDate) startStr = nextWorkingDay(asDateStr(b.startDate));
      if (b.extendedDays != null) dur = row.duration_days + Math.max(0, Math.round(Number(b.extendedDays) || 0));
      else if (b.durationDays != null) dur = Math.max(1, Math.round(Number(b.durationDays)));
      const newUser = b.userEmail && manage ? String(b.userEmail).toLowerCase() : String(row.user_email).toLowerCase();
      const endStr = addWorkingDays(startStr, Math.max(1, dur) - 1);
      const extended = Math.max(0, dur - row.duration_days);
      await sql`UPDATE schedule_assignments SET start_date = ${startStr}, end_date = ${endStr},
          extended_days = ${extended}, user_email = ${newUser}, auto_generated = FALSE, conflict = FALSE,
          conflict_reason = NULL, updated_at = NOW() WHERE id = ${aid}`;
      return res.status(200).json(await reload());
    }
    if (req.method === 'DELETE') {
      await sql`DELETE FROM schedule_assignments WHERE id = ${aid}`;
      return res.status(200).json(await reload());
    }
    return res.status(405).end();
  }

  // /api/crm/schedule/leave[/ :lid ]
  if (id === 'leave') {
    // POST create (self)
    if (!action && req.method === 'POST') {
      const b = req.body || {};
      const startStr = asDateStr(b.startDate);
      const endStr = asDateStr(b.endDate) || startStr;
      if (!startStr) return res.status(400).json({ error: 'startDate is required' });
      if (endStr < startStr) return res.status(400).json({ error: 'End date is before start date' });
      const target = (b.userEmail && manage) ? String(b.userEmail).toLowerCase() : email;
      const days = countWorkingDays(startStr, endStr);
      const kind = b.kind === 'compulsory' ? 'compulsory' : 'annual';
      const lid = makeId('leave');
      // People without an allowance tracked (directors/owners) just log days off —
      // no approval, it's their own record. Everyone else needs sign-off.
      const [al] = await sql`SELECT track_allowance FROM leave_allowances WHERE user_email = ${target}`;
      const autoApprove = al && al.track_allowance === false;
      if (autoApprove) {
        await sql`INSERT INTO leave_requests (id, user_email, start_date, end_date, days, kind, note, status, decided_by, decided_at)
          VALUES (${lid}, ${target}, ${startStr}, ${endStr}, ${days}, ${kind}, ${trimOrNull(b.note)}, 'approved', ${email}, NOW())`;
      } else {
        await sql`INSERT INTO leave_requests (id, user_email, start_date, end_date, days, kind, note, status)
          VALUES (${lid}, ${target}, ${startStr}, ${endStr}, ${days}, ${kind}, ${trimOrNull(b.note)}, 'pending')`;
        try { await notifyLeaveRequested(user, target, startStr, endStr, days); }
        catch (err) { console.warn('[schedule] leave notify failed', err.message); }
      }
      const clash = await leaveClashes(target, startStr, endStr);
      return res.status(201).json({ leaveConflict: clash, ...(await reload()) });
    }
    const lid = action;
    if (!lid) return res.status(400).json({ error: 'leave id required' });
    const [lr] = await sql`SELECT * FROM leave_requests WHERE id = ${lid}`;
    if (!lr) return res.status(404).json({ error: 'Not found' });
    const owner = String(lr.user_email).toLowerCase();

    // PATCH decide (leave approvers only — Admins & Directors)
    if (req.method === 'PATCH') {
      if (!approve) return res.status(403).json({ error: 'Only admins and directors can approve leave' });
      const status = (req.body || {}).status;
      if (!['approved', 'denied'].includes(status)) return res.status(400).json({ error: 'status must be approved or denied' });
      await sql`UPDATE leave_requests SET status = ${status}, decided_by = ${email}, decided_at = NOW() WHERE id = ${lid}`;
      let clash = false;
      if (status === 'approved') {
        // Any producer work already booked over these dates?
        clash = await leaveClashes(owner, asDateStr(lr.start_date), asDateStr(lr.end_date));
      }
      try { await notifyLeaveDecided(user, lr, status, clash); }
      catch (err) { console.warn('[schedule] leave decision notify failed', err.message); }
      return res.status(200).json({ leaveConflict: clash, ...(await reload()) });
    }
    // DELETE cancel (own request, or manager)
    if (req.method === 'DELETE') {
      if (!manage && owner !== email) return res.status(403).json({ error: 'Not your request' });
      await sql`DELETE FROM leave_requests WHERE id = ${lid}`;
      return res.status(200).json(await reload());
    }
    return res.status(405).end();
  }

  // /api/crm/schedule/allowance/:email  (leave approvers — Admins & Directors)
  if (id === 'allowance') {
    if (!approve) return res.status(403).json({ error: 'Only admins and directors can edit allowances' });
    if (req.method !== 'PATCH') return res.status(405).end();
    const target = String(action || '').toLowerCase();
    if (!target) return res.status(400).json({ error: 'user email required' });
    const b = req.body || {};
    await sql`INSERT INTO leave_allowances (user_email) VALUES (${target}) ON CONFLICT (user_email) DO NOTHING`;
    const sets = [];
    if (b.annualAllowance != null) await sql`UPDATE leave_allowances SET annual_allowance = ${Number(b.annualAllowance)}, updated_at = NOW() WHERE user_email = ${target}`;
    if (b.compulsoryDays != null) await sql`UPDATE leave_allowances SET compulsory_days = ${Number(b.compulsoryDays)}, updated_at = NOW() WHERE user_email = ${target}`;
    if (b.anniversary !== undefined) await sql`UPDATE leave_allowances SET anniversary = ${asDateStr(b.anniversary)}, updated_at = NOW() WHERE user_email = ${target}`;
    if (b.active != null) await sql`UPDATE leave_allowances SET active = ${!!b.active}, updated_at = NOW() WHERE user_email = ${target}`;
    if (b.trackAllowance != null) await sql`UPDATE leave_allowances SET track_allowance = ${!!b.trackAllowance}, updated_at = NOW() WHERE user_email = ${target}`;
    void sets;
    return res.status(200).json(await reload());
  }

  return res.status(404).json({ error: 'Unknown schedule route' });
}

// True if the user has scheduled production work overlapping [start,end].
async function leaveClashes(email, startStr, endStr) {
  const rows = await sql`SELECT start_date, end_date FROM schedule_assignments WHERE user_email = ${email}`;
  const leaveDays = new Set(workingDaysBetween(startStr, endStr));
  for (const r of rows) {
    for (const d of workingDaysBetween(asDateStr(r.start_date), asDateStr(r.end_date))) {
      if (leaveDays.has(d)) return true;
    }
  }
  return false;
}

async function notifyLeaveRequested(user, target, startStr, endStr, days) {
  const who = user?.name || user?.email || target;
  await sendNotification('leave.requested', {
    subject: `🌴 Leave request: ${who}`,
    html: `<p style="font-size:15px"><strong>${who}</strong> requested annual leave from <strong>${startStr}</strong> to <strong>${endStr}</strong> (${days} day${days === 1 ? '' : 's'}).</p>`
        + `<p><a href="${APP_URL}/#/schedule">Review in the schedule</a></p>`,
    text: `${who} requested leave ${startStr} → ${endStr} (${days}d). ${APP_URL}/#/schedule`,
    inApp: { title: `Leave request: ${who}`, body: `${startStr} → ${endStr} (${days}d)`, link: '#/schedule' },
  });
}

async function notifyLeaveDecided(actor, lr, status, clash) {
  const verb = status === 'approved' ? 'approved' : 'declined';
  const emoji = status === 'approved' ? '✅' : '🚫';
  const range = `${asDateStr(lr.start_date)} → ${asDateStr(lr.end_date)}`;
  const clashNote = clash && status === 'approved'
    ? ' There is a conflict in dates due to annual leave — please rearrange the schedule, or re-assign the project.'
    : '';
  await sendNotification('leave.decided', {
    assigneeEmails: [String(lr.user_email).toLowerCase()],
    subject: `${emoji} Leave ${verb}: ${range}`,
    html: `<p style="font-size:15px">Your leave request for <strong>${range}</strong> was <strong>${verb}</strong>.${clashNote}</p>`,
    text: `Your leave ${range} was ${verb}.${clashNote}`,
    inApp: { title: `Leave ${verb}`, body: `${range}${clashNote}`, link: '#/schedule' },
  });
}
