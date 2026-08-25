// Marketing → Brief builder. How the lead magnet is actually performing:
// how many people started a brief, how far through they got, what they wrote,
// and whether the nudge sequence chasing them is being read.
//
// WHY IT LIVES IN MARKETING rather than beside the per-deal brief card: a brief
// attached to a deal is production input and the deal page already shows it.
// An UNATTACHED brief is a lead — usually the only thing we know about someone
// who found us through the builder — and the question asked of it is a
// marketing question ("is this working, and who is worth a call"), not a
// production one.
//
// The progress figure is briefProgress(), the same function the portal shows the
// client and the nudge emails quote back at them. One definition of "62% done"
// across all three, so nobody has to reconcile two numbers that mean the same
// thing.

import sql from '../db.js';
import { ensureClientBriefs } from '../brief/db.js';
import { ensureCourseEmails, BRIEF_SEQUENCE } from '../course/emails.js';
import {
  SCREENS, ALL_QUESTIONS, briefProgress, renderBriefText, answerLabel,
} from '../brief/questions.js';

const BRIEF_KINDS = BRIEF_SEQUENCE.map((s) => s.kind);
const NUDGE_DAYS = Object.fromEntries(BRIEF_SEQUENCE.map((s) => [s.kind, s.days]));
const NUDGE_LABEL = {
  brief_1: 'Reminder 1',
  brief_2: 'Reminder 2',
  brief_3: 'Reminder 3',
  brief_offer: 'Offer',
};
const nudgeLabel = (kind) =>
  `${NUDGE_LABEL[kind] || kind}${NUDGE_DAYS[kind] ? ` · day ${NUDGE_DAYS[kind]}` : ''}`;

const round1 = (n) => Math.round(Number(n) * 10) / 10;

// Where a brief has got to. Deliberately four states and not a percentage:
// "submitted" is the only one that means we have the lead, and it is invisible
// in a progress bar (a submitted brief and an abandoned 100% one look identical).
function statusOf(b, pct) {
  if (b.submitted_at) return 'submitted';
  if (pct >= 100) return 'complete';
  if (pct > 0) return 'in_progress';
  return 'empty';
}

// Completion bands. The interesting split is not linear — everything hangs on
// whether they got past the first screen at all, so the bottom of the range is
// cut finer than the top.
const BANDS = [
  { key: 'empty', label: 'Not started', test: (p) => p <= 0 },
  { key: 'early', label: '1–25%', test: (p) => p > 0 && p <= 25 },
  { key: 'half', label: '26–50%', test: (p) => p > 25 && p <= 50 },
  { key: 'most', label: '51–75%', test: (p) => p > 50 && p <= 75 },
  { key: 'nearly', label: '76–99%', test: (p) => p > 75 && p < 100 },
  { key: 'full', label: '100%', test: (p) => p >= 100 },
];

// ── the report ───────────────────────────────────────────────────────────────

export async function briefsReport({ fromDate, toExcl, fromStr, toStr }) {
  await ensureClientBriefs();
  await ensureCourseEmails();

  const rows = await sql`
    SELECT b.id, b.title, b.answers, b.created_at, b.updated_at, b.submitted_at,
           b.next_step, b.next_step_at, b.contributor_count, b.deal_id,
           b.quote_request_id, b.portal_user_id, b.company_id,
           pu.name  AS user_name,
           pu.email AS user_email,
           c.name   AS company_name,
           d.title  AS deal_title
      FROM client_briefs b
      LEFT JOIN portal_users pu ON pu.id = b.portal_user_id
      LEFT JOIN companies    c  ON c.id  = b.company_id
      LEFT JOIN deals        d  ON d.id  = b.deal_id
     WHERE b.created_at >= ${fromDate} AND b.created_at < ${toExcl}
     ORDER BY b.updated_at DESC
     LIMIT 500
  `.catch((err) => { console.warn('[briefAnalytics] brief query failed', err.message); return []; });

  // Nudges are queued per PERSON (a course_signups row), not per brief, so they
  // attach by portal_user_id. Someone with two briefs sees the same sequence on
  // both — which is correct, there is only one sequence chasing them.
  const puids = [...new Set(rows.map((r) => r.portal_user_id).filter(Boolean))];
  const nudgeRows = puids.length ? await sql`
    SELECT s.portal_user_id AS puid, e.kind, e.sent_at, e.cancelled_at, e.scheduled_for,
           e.tracking_id,
           (SELECT MIN(ev.occurred_at) FROM email_tracking_events ev
             WHERE ev.tracking_id = e.tracking_id AND ev.kind = 'open')   AS opened_at,
           (SELECT COUNT(*)::int  FROM email_tracking_events ev
             WHERE ev.tracking_id = e.tracking_id AND ev.kind = 'click')  AS clicks
      FROM course_emails e
      JOIN course_signups s ON s.id = e.course_signup_id
     WHERE e.kind = ANY(${BRIEF_KINDS}) AND s.portal_user_id = ANY(${puids})
  `.catch((err) => { console.warn('[briefAnalytics] nudge query failed', err.message); return []; }) : [];

  const nudgeByUser = new Map();
  for (const n of nudgeRows) {
    if (!nudgeByUser.has(n.puid)) nudgeByUser.set(n.puid, []);
    nudgeByUser.get(n.puid).push(n);
  }

  // How many people arrived through the builder at all, whether or not they got
  // as far as opening a brief. The gap between this and `started` is the
  // signup-to-first-answer drop, which no other number here shows.
  const [signupRow] = await sql`
    SELECT COUNT(*)::int AS n
      FROM course_signups
     WHERE signup_source = 'brief'
       AND created_at >= ${fromDate} AND created_at < ${toExcl}
  `.catch(() => [{ n: 0 }]);

  // Per-question answer rates — the "mechanics" view. Which questions everyone
  // fills in, and which ones they leave blank or quit on.
  const counted = ALL_QUESTIONS.filter((q) => !q.screenOptional);
  const answeredCount = new Map(counted.map((q) => [q.key, 0]));

  const out = [];
  const bandCount = Object.fromEntries(BANDS.map((b) => [b.key, 0]));
  let pctSum = 0, finished = 0, submitted = 0, withDeal = 0, becameEnquiry = 0, touched = 0;
  const nextSteps = { call: 0, quote: 0, none: 0 };

  for (const b of rows) {
    const answers = b.answers || {};
    const p = briefProgress(answers);
    const status = statusOf(b, p.pct);

    pctSum += p.pct;
    if (p.pct > 0) touched += 1;
    if (p.pct >= 100) finished += 1;
    if (b.submitted_at) submitted += 1;
    if (b.deal_id) withDeal += 1;
    if (b.quote_request_id) becameEnquiry += 1;
    bandCount[BANDS.find((x) => x.test(p.pct)).key] += 1;
    if (b.next_step === 'call') nextSteps.call += 1;
    else if (b.next_step === 'quote') nextSteps.quote += 1;
    else nextSteps.none += 1;

    for (const q of counted) {
      if (answeredCount.has(q.key) && !isBlank(answers[q.key])) {
        answeredCount.set(q.key, answeredCount.get(q.key) + 1);
      }
    }

    const mine = nudgeByUser.get(b.portal_user_id) || [];
    const sentNudges = mine.filter((n) => n.sent_at);
    out.push({
      id: b.id,
      title: b.title || answers.projectName || 'Untitled brief',
      name: b.user_name || null,
      email: b.user_email || null,
      companyId: b.company_id || null,
      companyName: b.company_name || null,
      createdAt: b.created_at,
      updatedAt: b.updated_at,
      submittedAt: b.submitted_at || null,
      status,
      done: p.done,
      total: p.total,
      pct: p.pct,
      nextStep: b.next_step || null,
      contributors: Math.max(1, Number(b.contributor_count) || 1),
      dealId: b.deal_id || null,
      dealTitle: b.deal_title || null,
      quoteRequestId: b.quote_request_id || null,
      nudgesSent: sentNudges.length,
      nudgesOpened: sentNudges.filter((n) => n.opened_at).length,
      nudgesQueued: mine.filter((n) => !n.sent_at && !n.cancelled_at).length,
      lastNudgeAt: sentNudges.reduce(
        (acc, n) => (!acc || new Date(n.sent_at) > new Date(acc) ? n.sent_at : acc), null),
    });
  }

  return {
    from: fromStr,
    to: toStr,
    funnel: {
      signups: signupRow?.n || 0,
      started: rows.length,
      touched,              // at least one question answered
      finished,             // every counted question answered
      submitted,            // sent to us — the moment it becomes a lead
      becameEnquiry,        // raised a quote request
      withDeal,             // ended up attached to a deal
      avgPct: rows.length ? round1(pctSum / rows.length) : 0,
    },
    bands: BANDS.map((b) => ({ key: b.key, label: b.label, count: bandCount[b.key] })),
    nextSteps,
    questions: counted.map((q) => ({
      key: q.key,
      label: q.label,
      screen: q.screenKey,
      screenTitle: q.screenTitle,
      required: !!q.required,
      answered: answeredCount.get(q.key) || 0,
      pct: rows.length ? Math.round(((answeredCount.get(q.key) || 0) / rows.length) * 100) : 0,
    })),
    nudges: await nudgeSummary(fromDate, toExcl),
    rows: out,
  };
}

// Sequence performance over the period, counted by SEND date rather than by the
// briefs above — a nudge sent this month usually belongs to a brief started
// last month, and attributing it to the brief's date would show an empty table
// every time the range moved.
async function nudgeSummary(fromDate, toExcl) {
  const rows = await sql`
    SELECT e.kind,
           COUNT(*)::int                                          AS sent,
           COUNT(e.tracking_id)::int                              AS tracked,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM email_tracking_events ev
              WHERE ev.tracking_id = e.tracking_id AND ev.kind = 'open'))::int  AS opened,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM email_tracking_events ev
              WHERE ev.tracking_id = e.tracking_id AND ev.kind = 'click'))::int AS clicked
      FROM course_emails e
     WHERE e.kind = ANY(${BRIEF_KINDS})
       AND e.sent_at >= ${fromDate} AND e.sent_at < ${toExcl}
     GROUP BY e.kind
  `.catch((err) => { console.warn('[briefAnalytics] nudge summary failed', err.message); return []; });

  const [state] = await sql`
    SELECT COUNT(*) FILTER (WHERE sent_at IS NULL AND cancelled_at IS NULL)::int AS queued,
           COUNT(*) FILTER (WHERE cancelled_at IS NOT NULL)::int                 AS cancelled
      FROM course_emails
     WHERE kind = ANY(${BRIEF_KINDS})
  `.catch(() => [{ queued: 0, cancelled: 0 }]);

  const byKind = BRIEF_SEQUENCE.map((step) => {
    const r = rows.find((x) => x.kind === step.kind);
    const sent = r?.sent || 0;
    const tracked = r?.tracked || 0;
    const opened = r?.opened || 0;
    return {
      kind: step.kind,
      label: nudgeLabel(step.kind),
      sent,
      tracked,
      opened,
      clicked: r?.clicked || 0,
      // Out of the TRACKED sends, not all of them: nudges sent before tracking
      // existed are unmeasured, and counting them as unopened would report a
      // rate that quietly climbs as the old ones age out of the window.
      openRate: tracked ? round1((opened / tracked) * 100) : null,
    };
  });

  const totals = byKind.reduce((a, k) => ({
    sent: a.sent + k.sent, tracked: a.tracked + k.tracked,
    opened: a.opened + k.opened, clicked: a.clicked + k.clicked,
  }), { sent: 0, tracked: 0, opened: 0, clicked: 0 });

  return {
    ...totals,
    byKind,
    openRate: totals.tracked ? round1((totals.opened / totals.tracked) * 100) : null,
    clickRate: totals.tracked ? round1((totals.clicked / totals.tracked) * 100) : null,
    queuedNow: state?.queued || 0,
    cancelledTotal: state?.cancelled || 0,
  };
}

// ── one brief ────────────────────────────────────────────────────────────────

// Everything they typed, plus the sequence chasing them. The unanswered
// questions are included rather than filtered out — the gaps are the point of
// looking, and a list of only the answers hides where someone stopped.
export async function briefDetail(id) {
  await ensureClientBriefs();

  const [b] = await sql`
    SELECT b.*, pu.name AS user_name, pu.email AS user_email,
           c.name AS company_name, d.title AS deal_title
      FROM client_briefs b
      LEFT JOIN portal_users pu ON pu.id = b.portal_user_id
      LEFT JOIN companies    c  ON c.id  = b.company_id
      LEFT JOIN deals        d  ON d.id  = b.deal_id
     WHERE b.id = ${id}
  `.catch(() => []);
  if (!b) return null;

  const answers = b.answers || {};
  const p = briefProgress(answers);

  const screens = SCREENS.map((s) => ({
    key: s.key,
    title: s.title,
    optional: !!s.optional,
    questions: s.questions.map((q) => ({
      key: q.key,
      label: q.label,
      required: !!q.required,
      value: displayValue(q, answers),
    })),
  }));

  const nudges = await sql`
    SELECT e.kind, e.scheduled_for, e.sent_at, e.cancelled_at, e.tracking_id,
           (SELECT MIN(ev.occurred_at) FROM email_tracking_events ev
             WHERE ev.tracking_id = e.tracking_id AND ev.kind = 'open')  AS opened_at,
           (SELECT COUNT(*)::int FROM email_tracking_events ev
             WHERE ev.tracking_id = e.tracking_id AND ev.kind = 'open')  AS opens,
           (SELECT COUNT(*)::int FROM email_tracking_events ev
             WHERE ev.tracking_id = e.tracking_id AND ev.kind = 'click') AS clicks
      FROM course_emails e
      JOIN course_signups s ON s.id = e.course_signup_id
     WHERE e.kind = ANY(${BRIEF_KINDS}) AND s.portal_user_id = ${b.portal_user_id}
     ORDER BY e.scheduled_for ASC
  `.catch(() => []);

  return {
    id: b.id,
    title: b.title || answers.projectName || 'Untitled brief',
    name: b.user_name || null,
    email: b.user_email || null,
    companyId: b.company_id || null,
    companyName: b.company_name || null,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
    submittedAt: b.submitted_at || null,
    nextStep: b.next_step || null,
    nextStepAt: b.next_step_at || null,
    contributors: Math.max(1, Number(b.contributor_count) || 1),
    dealId: b.deal_id || null,
    dealTitle: b.deal_title || null,
    quoteRequestId: b.quote_request_id || null,
    done: p.done,
    total: p.total,
    pct: p.pct,
    screens,
    // The same rendering the deal card and the enquiry show, so what someone
    // reads here is word for word what production would read.
    text: renderBriefText(answers),
    nudges: nudges.map((n) => ({
      kind: n.kind,
      label: nudgeLabel(n.kind),
      scheduledFor: n.scheduled_for,
      sentAt: n.sent_at || null,
      cancelledAt: n.cancelled_at || null,
      tracked: n.tracking_id != null,
      openedAt: n.opened_at || null,
      opens: Number(n.opens) || 0,
      clicks: Number(n.clicks) || 0,
    })),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Mirrors isEmpty() in questions.js, which isn't exported. Kept in step with it
// deliberately: a question counted as answered by briefProgress() but shown
// blank here (or the reverse) would make the percentage look wrong.
function isBlank(v) {
  return v == null
    || (typeof v === 'string' && !v.trim())
    || (Array.isArray(v) && (v.length === 0 || v.every((r) => !r || (typeof r === 'object'
      ? !String(r.script || '').trim() && !String(r.visual || '').trim()
      : !String(r).trim()))));
}

// One answer as a person should read it: option slugs resolved to their labels
// (a budget stored as '5-10k' is meaningless out of context) and the script
// table summarised rather than dumped.
function displayValue(q, answers) {
  const v = answers?.[q.key];
  if (isBlank(v)) return null;
  if (q.type === 'scriptTable') {
    const filled = (Array.isArray(v) ? v : []).filter(
      (r) => r && (String(r.script || '').trim() || String(r.visual || '').trim()));
    return `${filled.length} scene${filled.length === 1 ? '' : 's'} drafted`;
  }
  const label = answerLabel(q.key, answers);
  return label == null ? String(v) : String(label);
}
