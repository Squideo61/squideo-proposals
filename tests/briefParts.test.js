// The brief is asked a part at a time. Two things must stay true, and both fail
// silently if they break:
//
//  1. Every question is reachable. A question that no part contains is a
//     question nobody is ever asked — the form still works, the brief still
//     sends, and an answer we rely on is simply missing for ever after.
//  2. Regrouping the FORM never changes the DOCUMENT. renderBriefText feeds
//     quote_requests.project_details and the alert email, so a layout change
//     that reworded a submitted brief would rewrite what the team reads.
import { describe, it, expect } from 'vitest';
import {
  SCREENS, ALL_QUESTIONS, screenParts, locateQuestion, renderBriefText,
} from '../api/_lib/brief/questions.js';

const allParts = () => SCREENS.flatMap((s) => screenParts(s));

describe('screenParts', () => {
  it('covers every question exactly once', () => {
    const seen = allParts().flatMap((p) => p.questions.map((q) => q.key));
    expect(seen.slice().sort()).toEqual(ALL_QUESTIONS.map((q) => q.key).sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('keeps a follow-up with the question it follows', () => {
    for (const q of ALL_QUESTIONS.filter((x) => x.follows)) {
      const part = allParts().find((p) => p.questions.some((x) => x.key === q.key));
      expect(part.questions.map((x) => x.key)).toContain(q.follows);
      // And after it: a follow-up rendered above its parent would appear before
      // the answer that unlocks it.
      const keys = part.questions.map((x) => x.key);
      expect(keys.indexOf(q.key)).toBeGreaterThan(keys.indexOf(q.follows));
    }
  });

  it('groups the pairs that share a card, and nothing else', () => {
    const grouped = allParts().filter((p) => p.questions.length > 1);
    expect(grouped.map((p) => p.questions.map((q) => q.key).join('+')).sort()).toEqual([
      'characters+voiceover+music',
      'deadline+deadlineDriver',
      'goal+goalDetail',
      'mustInclude+mustAvoid',
      'successMetric+successBaseline',
    ].sort());
  });

  it('never puts more than three questions on one card', () => {
    // The whole point is that no screen is a wall. Four is a wall.
    for (const p of allParts()) expect(p.questions.length).toBeLessThanOrEqual(3);
  });

  it('preserves the declared order of the questions', () => {
    for (const screen of SCREENS) {
      const flat = screenParts(screen).flatMap((p) => p.questions.map((q) => q.key));
      expect(flat).toEqual(screen.questions.map((q) => q.key));
    }
  });
});

describe('locateQuestion', () => {
  it('finds every question, and the part it is actually in', () => {
    for (const q of ALL_QUESTIONS) {
      const at = locateQuestion(q.key);
      expect(at, q.key).not.toBeNull();
      const part = screenParts(SCREENS[at.screenIndex])[at.partIndex];
      expect(part.questions.map((x) => x.key)).toContain(q.key);
    }
  });

  it('returns null for a key that is not a question', () => {
    expect(locateQuestion('notAQuestion')).toBeNull();
  });
});

describe('the submitted document', () => {
  // Pinned against the wording as it stands. If this fails, a change to the
  // FORM has changed what the TEAM reads — check that was intended before
  // updating the expectation.
  const answers = {
    projectName: 'Onboarding explainer',
    goal: 'onboard',
    goalDetail: 'Mostly for new starters',
    oneAction: 'Book a demo',
    audience: 'Care home managers',
    placements: ['homepage', 'sales'],
    length: '60-90',
    oneMessage: 'One place for ordering',
    budget: '5-10k',
    scriptRows: [{ script: 'Line one', visual: 'A shot' }],
  };

  it('renders from the flat question list, not from parts', () => {
    const text = renderBriefText(answers);
    // Screen headings, in declared order — parts are invisible here.
    expect(text).toContain('── THE VIDEO ──');
    expect(text).toContain("── WHO IT'S FOR ──");
    expect(text.indexOf('── THE VIDEO ──')).toBeLessThan(text.indexOf("── WHO IT'S FOR ──"));
    // Chip answers render as their labels, never their stored slugs: the CRM
    // scrapes the budget line for a number, and "5-10k" parses as £5.
    expect(text).toContain('£5,000 – £10,000 ex VAT');
    expect(text).not.toContain('5-10k');
    // A follow-up sits under its parent, as one more answered question.
    expect(text).toContain('Anything to add to that?');
    // Unanswered questions are omitted entirely rather than left blank.
    expect(text).not.toContain('And roughly what is that number today?');
  });
});

describe('the portal demo fixture', () => {
  // The demo is how this form gets reviewed, and an invented key fails silently:
  // the question just renders as unanswered and the demo shows a less complete
  // brief than it says it does. Five of these were wrong before this test.
  it('answers only real questions, with real option values', async () => {
    const src = await import('../src/portal/demo/portalDemo.js');
    const answers = src.DEMO_BRIEF_ANSWERS;
    const byKey = new Map(ALL_QUESTIONS.map((q) => [q.key, q]));
    for (const [key, value] of Object.entries(answers)) {
      const q = byKey.get(key);
      expect(q, `${key} is not a question`).toBeDefined();
      if (!q.options) continue;
      const valid = q.options.map((o) => o.value);
      for (const v of Array.isArray(value) ? value : [value]) {
        expect(valid, `${key} = ${v}`).toContain(v);
      }
    }
  });
});

describe('the demo guide fixture', () => {
  // The brief points six questions at a guide video by NUMBER. If the demo's
  // course fixture does not carry those numbers, every one of those links opens
  // a modal saying the video cannot be found — which is what happened before
  // this test, because the demo had no course fixture at all and the request
  // fell through to an empty object.
  it('has a module for every videoRef the brief cites', async () => {
    const demo = await import('../src/portal/demo/portalDemo.js');
    const course = await demo.demoRequest('GET', 'course');
    const numbers = new Set((course.modules || []).map((m) => m.moduleNumber));
    const cited = ALL_QUESTIONS.filter((q) => q.videoRef).map((q) => q.videoRef);
    expect(cited.length).toBeGreaterThan(0);
    for (const n of cited) expect(numbers, `videoRef ${n}`).toContain(n);
  });

  it('matches the shape the real course route returns', async () => {
    const demo = await import('../src/portal/demo/portalDemo.js');
    const course = await demo.demoRequest('GET', 'course');
    expect(course).toMatchObject({
      modules: expect.any(Array),
      completedCount: expect.any(Number),
      totalCount: expect.any(Number),
      percentComplete: expect.any(Number),
      allComplete: expect.any(Boolean),
    });
    for (const m of course.modules) {
      expect(Object.keys(m).sort()).toEqual([
        'completed', 'description', 'durationSeconds', 'id', 'moduleNumber',
        'posterUrl', 'resumeSeconds', 'slug', 'started', 'subtitle', 'title',
      ]);
    }
  });
});
