// Marketing → Brief builder. The numbers on this screen decide whether the
// lead magnet stays, so what's pinned here is the arithmetic that would be
// wrong quietly: the funnel steps, and the open rate's denominator.
//
// The open rate is the one worth guarding. Nudges sent before tracking existed
// carry no tracking row; counting them as unopened would report a rate that
// drifts upwards on its own as the untracked ones age out of the window, which
// looks like the copy improving when nothing changed.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock };
});
vi.mock('../api/_lib/email.js', () => ({ APP_URL: 'https://app.squideo.com' }));
vi.mock('../api/_lib/emailSuppression.js', () => ({
  unsubscribeUrlFor: (email, scope) => `https://app.squideo.com/unsub?e=${email}&s=${scope}`,
}));

import { setSqlHandler, resetSqlMock } from './helpers/mockDb.js';
import { briefsReport, briefDetail } from '../api/_lib/crm/briefAnalytics.js';
import { invalidateDemoScope } from '../api/_lib/crm/demoScope.js';
import { briefProgress, ALL_QUESTIONS } from '../api/_lib/brief/questions.js';

const RANGE = {
  fromDate: new Date('2026-08-01T00:00:00Z'),
  toExcl: new Date('2026-09-01T00:00:00Z'),
  fromStr: '2026-08-01',
  toStr: '2026-09-01',
};

// Enough of a real answer set to move the progress figure off 0 and off 100.
const PART_ANSWERS = { projectName: 'Onboarding explainer', goal: 'explain' };
const FULL_ANSWERS = Object.fromEntries(
  ALL_QUESTIONS.filter((q) => !q.screenOptional).map((q) => [q.key, 'answered']));

function brief(over = {}) {
  return {
    id: 'brf_1',
    title: null,
    answers: {},
    created_at: '2026-08-02T10:00:00Z',
    updated_at: '2026-08-03T10:00:00Z',
    submitted_at: null,
    next_step: null,
    next_step_at: null,
    contributor_count: 1,
    deal_id: null,
    quote_request_id: null,
    portal_user_id: 'pu_1',
    company_id: 'co_1',
    user_name: 'Hannah',
    user_email: 'hannah@example.com',
    company_name: 'Example Ltd',
    deal_title: null,
    ...over,
  };
}

// One handler for every query the report makes, routed on a unique fragment.
// `FROM client_briefs` is matched FIRST because that query also joins
// portal_users, which the internal-accounts lookup below matches on.
function install({
  briefs = [], nudges = [], signups = 0, byKind = [], state = null,
  internalIds = [], demoRows = [],
}) {
  setSqlHandler((text) => {
    if (text.includes('FROM client_briefs')) return briefs;
    if (text.includes('signup_source')) return [{ n: signups }];
    if (text.includes('GROUP BY e.kind')) return byKind;
    if (text.includes('sent_at IS NULL AND cancelled_at IS NULL')) {
      return [state || { queued: 0, cancelled: 0 }];
    }
    if (text.includes('JOIN course_signups')) return nudges;
    if (text.includes('FROM portal_users')) return internalIds.map((id) => ({ id }));
    if (text.includes('FROM companies c')) return demoRows;
    return [];                                    // the ensure*() DDL
  });
}

// demoScope() caches for a TTL, so without this a test that seeds a demo
// company leaks it into every test that runs after it.
beforeEach(() => { resetSqlMock(); invalidateDemoScope(); });

describe('the funnel', () => {
  it('separates arriving, starting, answering and sending', async () => {
    install({
      signups: 10,
      briefs: [
        brief({ id: 'a', answers: {} }),                                  // opened, never typed
        brief({ id: 'b', answers: PART_ANSWERS }),                        // part way
        brief({ id: 'c', answers: FULL_ANSWERS }),                        // finished, not sent
        brief({ id: 'd', answers: FULL_ANSWERS, submitted_at: '2026-08-09T09:00:00Z', quote_request_id: 'qr_1', deal_id: 'deal_1' }),
      ],
    });

    const r = await briefsReport(RANGE);

    expect(r.funnel.signups).toBe(10);
    expect(r.funnel.started).toBe(4);
    // The gap between signups and started is the drop we can't see anywhere
    // else — someone who asked for the builder and never opened it.
    expect(r.funnel.touched).toBe(3);
    expect(r.funnel.finished).toBe(2);
    expect(r.funnel.submitted).toBe(1);
    expect(r.funnel.becameEnquiry).toBe(1);
    expect(r.funnel.withDeal).toBe(1);
  });

  it('bands every brief exactly once', async () => {
    install({
      briefs: [
        brief({ id: 'a', answers: {} }),
        brief({ id: 'b', answers: PART_ANSWERS }),
        brief({ id: 'c', answers: FULL_ANSWERS }),
      ],
    });
    const r = await briefsReport(RANGE);
    expect(r.bands.reduce((a, b) => a + b.count, 0)).toBe(3);
    expect(r.bands.find((b) => b.key === 'empty').count).toBe(1);
    expect(r.bands.find((b) => b.key === 'full').count).toBe(1);
  });

  it('reports the same progress the client and the nudge emails see', async () => {
    install({ briefs: [brief({ answers: PART_ANSWERS })] });
    const r = await briefsReport(RANGE);
    const expected = briefProgress(PART_ANSWERS);
    expect(r.rows[0].pct).toBe(expected.pct);
    expect(r.rows[0].done).toBe(expected.done);
    expect(r.rows[0].total).toBe(expected.total);
    expect(r.funnel.avgPct).toBe(expected.pct);
  });

  it('counts answers per question, so a dead question is visible', async () => {
    install({
      briefs: [
        brief({ id: 'a', answers: PART_ANSWERS }),
        brief({ id: 'b', answers: { projectName: 'Just the name' } }),
      ],
    });
    const r = await briefsReport(RANGE);
    const name = r.questions.find((q) => q.key === 'projectName');
    const goal = r.questions.find((q) => q.key === 'goal');
    expect(name.answered).toBe(2);
    expect(name.pct).toBe(100);
    expect(goal.answered).toBe(1);
    expect(goal.pct).toBe(50);
  });

  it('treats whitespace as unanswered, like the progress bar does', async () => {
    install({ briefs: [brief({ answers: { projectName: '   ' } })] });
    const r = await briefsReport(RANGE);
    expect(r.rows[0].pct).toBe(0);
    expect(r.funnel.touched).toBe(0);
    expect(r.questions.find((q) => q.key === 'projectName').answered).toBe(0);
  });
});

// This report measures a lead magnet, so it should only count strangers. Each
// of these would otherwise move every conversion rate on the page, quietly and
// in the flattering direction — a test run counts as a signup that converted.
describe('who counts', () => {
  it('keeps a project-linked brief in the figures but out of the list', async () => {
    install({
      briefs: [
        brief({ id: 'lead', answers: PART_ANSWERS }),
        brief({ id: 'won', answers: FULL_ANSWERS, deal_id: 'deal_1', deal_title: 'S&E Care Trade' }),
      ],
    });
    const r = await briefsReport(RANGE);

    // "Became a deal" is the magnet's best outcome — dropping it from the
    // funnel would hide the one number that justifies the whole thing.
    expect(r.funnel.started).toBe(2);
    expect(r.funnel.withDeal).toBe(1);
    // ...but the list is a queue of leads to work, and that one is already won.
    expect(r.rows.map((x) => x.id)).toEqual(['lead']);
    expect(r.excluded.linkedToProject).toBe(1);
  });

  it('drops our own accounts from the figures AND the list', async () => {
    install({
      briefs: [
        brief({ id: 'real', answers: PART_ANSWERS }),
        brief({ id: 'ours', answers: FULL_ANSWERS, portal_user_id: 'pu_staff' }),
      ],
      internalIds: ['pu_staff'],
    });
    const r = await briefsReport(RANGE);

    expect(r.funnel.started).toBe(1);
    expect(r.funnel.finished).toBe(0);       // the staff one was the finished one
    expect(r.rows.map((x) => x.id)).toEqual(['real']);
    expect(r.excluded.internal).toBe(1);
  });

  it('drops the seeded demo project', async () => {
    install({
      briefs: [
        brief({ id: 'real', answers: PART_ANSWERS }),
        brief({ id: 'demo', answers: FULL_ANSWERS, company_id: 'co_demo' }),
      ],
      demoRows: [{ company_id: 'co_demo', deal_id: 'deal_demo' }],
    });
    const r = await briefsReport(RANGE);

    expect(r.funnel.started).toBe(1);
    expect(r.rows.map((x) => x.id)).toEqual(['real']);
    expect(r.excluded.demo).toBe(1);
  });

  it('still LISTS a hand-scrubbed brief, flagged, so it can be put back', async () => {
    install({
      briefs: [
        brief({ id: 'real', answers: PART_ANSWERS }),
        brief({ id: 'test', answers: FULL_ANSWERS, excluded_at: '2026-08-10T09:00:00Z' }),
      ],
    });
    const r = await briefsReport(RANGE);

    // Out of every number...
    expect(r.funnel.started).toBe(1);
    expect(r.funnel.finished).toBe(0);
    expect(r.excluded.scrubbed).toBe(1);
    // ...but still returned, or a wrong call would be unrecoverable from the UI.
    expect(r.rows.find((x) => x.id === 'test')?.excluded).toBe(true);
    expect(r.rows.find((x) => x.id === 'real')?.excluded).toBe(false);
  });

  it('leaves the per-question denominator on countable briefs only', async () => {
    install({
      briefs: [
        brief({ id: 'real', answers: FULL_ANSWERS }),
        brief({ id: 'ours', answers: {}, portal_user_id: 'pu_staff' }),
      ],
      internalIds: ['pu_staff'],
    });
    const r = await briefsReport(RANGE);
    // One countable brief, and it answered everything: 100%, not 50%.
    expect(r.questions.every((q) => q.pct === 100)).toBe(true);
  });
});

describe('reminder emails', () => {
  it('rates opens against the tracked sends, not every send', async () => {
    install({
      briefs: [],
      byKind: [
        // Six went out, but two predate tracking. One of the four measurable
        // ones was opened — that is 25%, not 16.7%.
        { kind: 'brief_1', sent: 6, tracked: 4, opened: 1, clicked: 0 },
      ],
    });
    const r = await briefsReport(RANGE);
    const step = r.nudges.byKind.find((k) => k.kind === 'brief_1');
    expect(step.sent).toBe(6);
    expect(step.openRate).toBe(25);
    expect(r.nudges.openRate).toBe(25);
  });

  it('reports no rate at all when nothing is measurable', async () => {
    install({ briefs: [], byKind: [{ kind: 'brief_1', sent: 3, tracked: 0, opened: 0, clicked: 0 }] });
    const r = await briefsReport(RANGE);
    // null, not 0 — "we cannot say" and "nobody opened it" are different
    // answers and the UI prints them differently.
    expect(r.nudges.byKind.find((k) => k.kind === 'brief_1').openRate).toBeNull();
    expect(r.nudges.openRate).toBeNull();
  });

  it('lists every step of the sequence even before any have gone out', async () => {
    install({ briefs: [], byKind: [] });
    const r = await briefsReport(RANGE);
    expect(r.nudges.byKind.map((k) => k.kind)).toEqual(['brief_1', 'brief_2', 'brief_3', 'brief_offer']);
    expect(r.nudges.byKind.every((k) => k.sent === 0)).toBe(true);
  });

  it('attaches each person their own sends, opened ones counted once', async () => {
    install({
      briefs: [brief({ portal_user_id: 'pu_1' })],
      nudges: [
        { puid: 'pu_1', kind: 'brief_1', sent_at: '2026-08-04T09:00:00Z', cancelled_at: null, scheduled_for: '2026-08-04T09:00:00Z', tracking_id: 1, opened_at: '2026-08-04T11:00:00Z', clicks: 1 },
        { puid: 'pu_1', kind: 'brief_2', sent_at: '2026-08-07T09:00:00Z', cancelled_at: null, scheduled_for: '2026-08-07T09:00:00Z', tracking_id: 2, opened_at: null, clicks: 0 },
        { puid: 'pu_1', kind: 'brief_3', sent_at: null, cancelled_at: null, scheduled_for: '2026-08-13T09:00:00Z', tracking_id: null, opened_at: null, clicks: 0 },
        { puid: 'pu_other', kind: 'brief_1', sent_at: '2026-08-04T09:00:00Z', cancelled_at: null, scheduled_for: null, tracking_id: 3, opened_at: '2026-08-04T10:00:00Z', clicks: 0 },
      ],
    });
    const r = await briefsReport(RANGE);
    expect(r.rows[0].nudgesSent).toBe(2);
    expect(r.rows[0].nudgesOpened).toBe(1);
    expect(r.rows[0].nudgesQueued).toBe(1);
    expect(r.rows[0].lastNudgeAt).toBe('2026-08-07T09:00:00Z');
  });
});

describe('one brief', () => {
  it('shows the unanswered questions too', async () => {
    setSqlHandler((text) => {
      if (text.includes('FROM client_briefs')) return [brief({ answers: PART_ANSWERS })];
      if (text.includes('JOIN course_signups')) return [];
      return [];
    });
    const d = await briefDetail('brf_1');
    const video = d.screens.find((s) => s.key === 'video');
    expect(video.questions.find((q) => q.key === 'projectName').value).toBe('Onboarding explainer');
    // The gaps are the point of opening it — a list of only the answers hides
    // where someone stopped.
    expect(video.questions.find((q) => q.key === 'oneAction').value).toBeNull();
  });

  it('resolves option slugs to the label a person would read', async () => {
    setSqlHandler((text) => {
      if (text.includes('FROM client_briefs')) return [brief({ answers: { goal: 'explain' } })];
      return [];
    });
    const d = await briefDetail('brf_1');
    const goal = d.screens.find((s) => s.key === 'video').questions.find((q) => q.key === 'goal');
    expect(goal.value).toBe('Explaining a product or service');
  });

  it('is null for a brief that does not exist', async () => {
    setSqlHandler(() => []);
    expect(await briefDetail('nope')).toBeNull();
  });
});
