// The brief-builder nudge series shares the course's table, cron and
// suppression. What's pinned here is the seam between the two sequences,
// because the failure mode is silent: a gate that cancels too widely doesn't
// error, it just stops emailing a warm lead and nobody notices.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock };
});
vi.mock('../api/_lib/email.js', () => ({ APP_URL: 'https://app.squideo.com' }));
vi.mock('../api/_lib/emailSuppression.js', () => ({
  unsubscribeUrlFor: (email, scope) => `https://app.squideo.com/unsub?e=${email}&s=${scope}`,
}));

import { setSqlHandler, resetSqlMock, getSqlCalls } from './helpers/mockDb.js';
import {
  SEQUENCE, BRIEF_SEQUENCE, stepFor, kindsInFamily,
  scheduleBriefEmails, scheduleCourseEmails, buildNudgeEmail,
} from '../api/_lib/course/emails.js';

beforeEach(() => {
  resetSqlMock();
  setSqlHandler(() => []);
});

describe('sequence definitions', () => {
  it('keeps the two families separate and complete', () => {
    expect(kindsInFamily('course')).toEqual(SEQUENCE.map((s) => s.kind));
    expect(kindsInFamily('brief')).toEqual(BRIEF_SEQUENCE.map((s) => s.kind));
    // No kind may appear in both, or a family-scoped cancel would reach across.
    const overlap = kindsInFamily('course').filter((k) => kindsInFamily('brief').includes(k));
    expect(overlap).toEqual([]);
  });

  it('only asks for consent on the emails that sell', () => {
    // The teaching nudges run on legitimate interest — they help someone finish
    // the thing they themselves started. Anything that pitches needs the tick.
    const needsTick = BRIEF_SEQUENCE.filter((s) => s.needsConsent).map((s) => s.kind);
    expect(needsTick).toEqual(['brief_offer']);
  });

  it('resolves a step to its family', () => {
    expect(stepFor('brief_2').family).toBe('brief');
    expect(stepFor('nudge_2').family).toBe('course');
    expect(stepFor('does_not_exist')).toBeNull();
  });

  it('schedules in ascending order so a later nudge cannot overtake an earlier one', () => {
    const days = BRIEF_SEQUENCE.map((s) => s.days);
    expect([...days].sort((a, b) => a - b)).toEqual(days);
  });
});

describe('scheduling', () => {
  it('queues only its own family', async () => {
    await scheduleBriefEmails('csu-1', 'jo@acme.co.uk');
    const kinds = getSqlCalls()
      .filter((c) => c.text.includes('INSERT INTO course_emails'))
      .map((c) => c.values[3]);
    expect(kinds).toEqual(BRIEF_SEQUENCE.map((s) => s.kind));
  });

  it('lets both series exist for one signup', async () => {
    await scheduleCourseEmails('csu-1', 'jo@acme.co.uk');
    await scheduleBriefEmails('csu-1', 'jo@acme.co.uk');
    const kinds = getSqlCalls()
      .filter((c) => c.text.includes('INSERT INTO course_emails'))
      .map((c) => c.values[3]);
    expect(kinds).toHaveLength(SEQUENCE.length + BRIEF_SEQUENCE.length);
    // The unique index is (signup, kind), so adding the second series must not
    // collide with the first.
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('does nothing without a signup or an address', async () => {
    await scheduleBriefEmails(null, 'jo@acme.co.uk');
    await scheduleBriefEmails('csu-1', null);
    expect(getSqlCalls().filter((c) => c.text.includes('INSERT INTO course_emails'))).toHaveLength(0);
  });
});

describe('copy', () => {
  const ctx = { email: 'jo@acme.co.uk', name: 'Jo', answered: 7, totalQuestions: 25 };

  it('points brief emails at the brief, not the course', () => {
    const built = buildNudgeEmail('brief_1', ctx);
    expect(built.html).toContain('/portal#/brief');
    expect(built.html).not.toContain('/portal#/course');
    expect(built.text).toContain('/portal#/brief');
  });

  it('brands the shell for the sequence it belongs to', () => {
    expect(buildNudgeEmail('brief_1', ctx).html).toContain('Video Brief');
    expect(buildNudgeEmail('nudge_1', { ...ctx, videosDone: 2 }).html).toContain('Crash Course');
  });

  it('tells someone how far in they actually are', () => {
    const built = buildNudgeEmail('brief_1', ctx);
    expect(built.subject).toContain('7');
    expect(built.html).toContain('7 of 25');
  });

  it('does not claim progress when there is none', () => {
    const built = buildNudgeEmail('brief_1', { ...ctx, answered: 0 });
    expect(built.subject).toBe('Your video brief is still blank');
    expect(built.html).not.toContain('0 of 25');
  });

  it('always carries an unsubscribe link', () => {
    for (const s of BRIEF_SEQUENCE) {
      const built = buildNudgeEmail(s.kind, ctx);
      expect(built.unsubscribeUrl).toBeTruthy();
      // The href is HTML-escaped (& → &amp;), as it must be, so match the
      // escaped form rather than the raw URL.
      expect(built.html).toContain(built.unsubscribeUrl.replace(/&/g, '&amp;'));
      // The plain-text part is not escaped, so it carries the URL verbatim.
      expect(built.text).toContain(built.unsubscribeUrl);
      expect(built.text).toContain('Unsubscribe');
    }
  });

  it('labels the unsubscribe by which sequence lost them', () => {
    expect(buildNudgeEmail('brief_1', ctx).unsubscribeUrl).toContain('s=brief');
    expect(buildNudgeEmail('nudge_1', { ...ctx, videosDone: 0 }).unsubscribeUrl).toContain('s=course');
  });

  it('returns null for a kind with no template rather than sending a blank', () => {
    expect(buildNudgeEmail('no_such_kind', ctx)).toBeNull();
  });
});
