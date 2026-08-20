// Collaboration for the client brief: who changed what, who is typing right
// now, and telling the rest of the team when something moved.
//
// The brief is a shared document with no locking, because locking a form
// twenty-five questions long means one person holds it and the other two give
// up. Instead: every answer is merged server-side per question (so two people
// on different questions never collide), every change is recorded with a name
// against it, and anyone editing a question is shown on that question so the
// second person moves to another one rather than fighting over it.
//
// The diffing and summarising have no DB access so they can be tested
// directly; the write helpers are best-effort and never throw, because a
// failed activity row must not cost the client their answer.

import sql, { batchWrite } from '../db.js';
import { makeId } from '../crm/shared.js';
import { ALL_QUESTIONS } from './questions.js';

// Someone is "here" if we've heard from their tab within this window. Two
// heartbeats' worth, so one dropped request doesn't blink them out of the list.
export const PRESENCE_WINDOW_SECONDS = 50;

const QUESTION_BY_KEY = new Map(ALL_QUESTIONS.map((q) => [q.key, q]));

// Must agree with isEmpty() in questions.js — if the two disagree, the feed
// reports an answer as cleared while the form still shows it filled in.
const isBlank = (v) =>
  v == null ||
  (typeof v === 'string' && !v.trim()) ||
  (Array.isArray(v) && (v.length === 0 || v.every((r) => !r || (typeof r === 'object'
    ? !String(r.script || '').trim() && !String(r.visual || '').trim()
    : !String(r).trim()))));

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// A one-line version of an answer, for the activity feed and the digest email.
// Long prose answers are the norm here, and a feed that prints 400 words per
// entry is a feed nobody reads.
export function summariseAnswer(key, value, max = 90) {
  if (isBlank(value)) return null;
  const q = QUESTION_BY_KEY.get(key);
  if (q?.options) {
    const find = (v) => q.options.find((o) => o.value === v)?.label || v;
    const text = Array.isArray(value) ? value.map(find).join(', ') : find(value);
    return String(text);
  }
  if (Array.isArray(value)) {
    const rows = value.filter((r) => r && (typeof r === 'object'
      ? String(r.script || '').trim() || String(r.visual || '').trim()
      : String(r).trim()));
    return `${rows.length} row${rows.length === 1 ? '' : 's'}`;
  }
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// What actually changed between the stored answers and an incoming patch.
// Keys whose value is identical are dropped, which is what stops the autosave
// (which posts a whole screen on a debounce) from logging "changed" every time
// someone tabs through a field without touching it.
export function diffAnswers(before = {}, patch = {}) {
  const out = [];
  for (const [key, after] of Object.entries(patch || {})) {
    const prev = before?.[key];
    if (same(prev, after)) continue;
    const q = QUESTION_BY_KEY.get(key);
    out.push({
      questionKey: key,
      questionLabel: q?.label || key,
      eventKey: isBlank(after) ? 'answer.cleared' : 'answer.changed',
      firstAnswer: isBlank(prev) && !isBlank(after),
      before: prev ?? null,
      after: after ?? null,
    });
  }
  return out;
}

// The feed line for one event. Kept here rather than in the component so the
// digest email and the portal feed cannot describe the same change differently.
export function describeEvent(e) {
  const who = e.actorName || 'Someone';
  const label = e.questionLabel || 'a question';
  switch (e.eventKey) {
    case 'brief.created':   return `${who} started this brief`;
    case 'brief.attached':  return `${who} linked this brief to ${e.attachedTo || 'a project'}`;
    case 'brief.finalised': return `${who} finalised the brief`;
    case 'brief.reopened':  return `${who} reopened the brief for editing`;
    case 'answer.cleared':  return `${who} cleared “${label}”`;
    case 'answer.changed':  return `${who} ${e.firstAnswer ? 'answered' : 'updated'} “${label}”`;
    default:                return `${who} made a change`;
  }
}

// ── writes ───────────────────────────────────────────────────────────────────

// One INSERT per event, sent as a single round trip. The Neon HTTP driver costs
// a round trip per query, so a per-row await loop on a screen with eight
// answers would be eight sequential network hops inside the client's save path.
export async function recordBriefEvents(briefId, actor, changes) {
  if (!briefId || !changes?.length) return [];
  const rows = changes.map((c) => ({ id: makeId('cbe'), ...c }));
  try {
    await batchWrite(rows.map((r) => sql`
      INSERT INTO client_brief_events
        (id, brief_id, portal_user_id, staff_email, actor_name, event_key,
         question_key, question_label, before_value, after_value)
      VALUES (${r.id}, ${briefId}, ${actor?.portalUserId || null}, ${actor?.staffEmail || null},
              ${actor?.name || null}, ${r.eventKey},
              ${r.questionKey || null}, ${r.questionLabel || null},
              ${JSON.stringify(r.before ?? null)}::jsonb,
              ${JSON.stringify(r.after ?? null)}::jsonb)
    `));
  } catch (err) {
    console.warn('[brief] recordBriefEvents failed', err.message);
    return [];
  }
  return rows;
}

export function serialiseEvent(r) {
  const e = {
    id: r.id,
    portalUserId: r.portal_user_id || null,
    staffEmail: r.staff_email || null,
    actorName: r.actor_name || (r.staff_email ? 'Squideo' : 'Someone'),
    eventKey: r.event_key,
    questionKey: r.question_key || null,
    questionLabel: r.question_label || null,
    // The PREVIOUS value is deliberately not shipped to the browser for
    // anything but a clear: the feed's job is to say what the brief says now,
    // and sending every superseded draft of every answer to every colleague is
    // a lot of noise. before_value stays in the database, so an accidental
    // overwrite is still recoverable by reading it.
    summary: summariseAnswer(r.question_key, r.after_value),
    firstAnswer: r.before_value == null || isBlank(r.before_value),
    at: r.created_at,
  };
  e.text = describeEvent({
    ...e,
    attachedTo: typeof r.after_value === 'string' ? r.after_value : null,
  });
  return e;
}

// The activity feed, newest first.
export async function loadBriefActivity(briefId, limit = 60) {
  if (!briefId) return [];
  const rows = await sql`
    SELECT id, portal_user_id, staff_email, actor_name, event_key,
           question_key, question_label, before_value, after_value, created_at
      FROM client_brief_events
     WHERE brief_id = ${briefId}
     ORDER BY created_at DESC, id DESC
     LIMIT ${Math.min(Math.max(Number(limit) || 60, 1), 200)}
  `.catch(() => []);
  return rows.map(serialiseEvent);
}

// Heartbeat. Upserts the caller's row and returns everyone ELSE who is live.
export async function touchPresence({ briefId, portalUserId, name, questionKey }) {
  if (!briefId || !portalUserId) return [];
  try {
    await sql`
      INSERT INTO client_brief_presence (brief_id, portal_user_id, actor_name, question_key, last_seen_at)
      VALUES (${briefId}, ${portalUserId}, ${name || null}, ${questionKey || null}, NOW())
      ON CONFLICT (brief_id, portal_user_id)
      DO UPDATE SET actor_name   = EXCLUDED.actor_name,
                    question_key = EXCLUDED.question_key,
                    last_seen_at = NOW()`;
  } catch (err) {
    console.warn('[brief] touchPresence failed', err.message);
  }
  return loadPresence(briefId, portalUserId);
}

// Who else is on this brief right now. `excludeUserId` keeps the caller out of
// their own "also editing" list.
export async function loadPresence(briefId, excludeUserId = null) {
  if (!briefId) return [];
  const rows = await sql`
    SELECT portal_user_id, actor_name, question_key, last_seen_at
      FROM client_brief_presence
     WHERE brief_id = ${briefId}
       AND last_seen_at > NOW() - (${PRESENCE_WINDOW_SECONDS} * INTERVAL '1 second')
       AND (${excludeUserId}::text IS NULL OR portal_user_id <> ${excludeUserId})
     ORDER BY last_seen_at DESC
  `.catch(() => []);
  return rows.map((r) => ({
    portalUserId: r.portal_user_id,
    name: r.actor_name || 'A colleague',
    questionKey: r.question_key || null,
    at: r.last_seen_at,
  }));
}

// How many distinct people have touched this brief — shown on the list so a
// shared brief reads as shared before you open it.
export async function refreshContributorCount(briefId) {
  if (!briefId) return;
  try {
    await sql`
      UPDATE client_briefs
         SET contributor_count = GREATEST(1, (
               SELECT COUNT(DISTINCT portal_user_id)::int
                 FROM client_brief_events
                WHERE brief_id = ${briefId} AND portal_user_id IS NOT NULL))
       WHERE id = ${briefId}`;
  } catch (err) {
    console.warn('[brief] refreshContributorCount failed', err.message);
  }
}
