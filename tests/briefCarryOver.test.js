// A second brief pre-fills what is about the CLIENT and leaves blank what is
// about the VIDEO.
//
// The split is the whole feature, and the failure is asymmetric. Missing a
// carry-over costs somebody thirty seconds of re-typing. Carrying something
// that should be blank puts last video's answer in front of them as if it were
// this video's — and people accept defaults, so it ends up in the brief, in the
// quote, and in the video.
import { describe, it, expect } from 'vitest';
import {
  SCREENS, ALL_QUESTIONS, CARRY_OVER_KEYS, carryOverAnswers, renderBriefText,
} from '../api/_lib/brief/questions.js';

const FULL = {
  projectName: 'Northwind Ordering launch film',
  goal: 'onboard',
  goalDetail: 'For existing care-home customers.',
  oneAction: 'Book a demonstration.',
  successMetric: 'Demo bookings',
  successBaseline: 'About four a month',
  audience: 'Care home owners and group directors.',
  awareness: 'problem',
  placements: ['homepage', 'sales'],
  length: '60-90',
  oneMessage: 'Everything in one place.',
  keyPoints: 'One login. Approvals routed automatically.',
  mustInclude: 'The Northwind logo.',
  mustAvoid: 'Anything that looks like a finance product.',
  characters: 'yes',
  voiceover: 'pro',
  music: 'unsure',
  references: 'https://example.com/video',
  brandAssets: 'guidelines',
  deadline: 'Mid-October',
  deadlineDriver: 'The regional care conference',
  volume: 'one',
  budget: '5-10k',
  approvers: 'Alex signs it off.',
  scriptRows: [{ script: 'Line one.', visual: 'A door.' }],
  worthIt: 'Fewer repeat questions on calls.',
};

describe('what carries into the next brief', () => {
  it('carries what is about the client, not the video', () => {
    expect(CARRY_OVER_KEYS.slice().sort()).toEqual([
      'approvers', 'audience', 'brandAssets', 'budget', 'characters',
      'music', 'mustAvoid', 'mustInclude', 'references', 'voiceover',
    ].sort());
  });

  it('leaves every question that describes THIS video blank', () => {
    const carried = carryOverAnswers(FULL);
    for (const key of [
      'projectName', 'goal', 'goalDetail', 'oneAction', 'successMetric', 'successBaseline',
      'placements', 'length', 'oneMessage', 'keyPoints', 'deadline', 'deadlineDriver',
      'scriptRows', 'worthIt',
    ]) {
      expect(carried, key).not.toHaveProperty(key);
    }
  });

  it('leaves awareness blank — it is the thing that moves across a series', () => {
    // Video one is for strangers; video three is for someone comparing options.
    expect(carryOverAnswers(FULL)).not.toHaveProperty('awareness');
  });

  it('leaves volume blank — it asks about the enquiry, not the client', () => {
    // Carrying "just this one" onto their second brief is the form
    // contradicting itself.
    expect(carryOverAnswers(FULL)).not.toHaveProperty('volume');
  });

  it('carries exactly one REQUIRED answer, and it is audience', () => {
    // Required questions are the ones Finalise blocks on, so pre-filling one
    // means a brief can be sent without its author having read that question.
    // That is a deliberate exception for `audience` and nothing else: it is the
    // longest answer in the brief, it does not change between two videos for
    // the same organisation, and re-typing it is the friction this whole
    // feature exists to remove. It is marked "from your last brief" on screen.
    //
    // If this fails because another required question grew a carriesOver flag,
    // that is the point — decide whether it has earned the same exception
    // rather than inheriting it by accident.
    const required = new Set(ALL_QUESTIONS.filter((q) => q.required).map((q) => q.key));
    const carriedRequired = CARRY_OVER_KEYS.filter((k) => required.has(k));
    expect(carriedRequired).toEqual(['audience']);
  });

  it('drops blanks rather than copying them', () => {
    // A question they skipped last time is simply asked again, not pre-filled
    // with emptiness that would still count as "carried" in the UI.
    const carried = carryOverAnswers({
      ...FULL, audience: '   ', references: '', characters: null, mustAvoid: [],
    });
    for (const key of ['audience', 'references', 'characters', 'mustAvoid']) {
      expect(carried, key).not.toHaveProperty(key);
    }
    expect(carried.budget).toBe('5-10k');
  });

  it('survives an empty or missing brief', () => {
    expect(carryOverAnswers({})).toEqual({});
    expect(carryOverAnswers()).toEqual({});
    expect(carryOverAnswers(null)).toEqual({});
  });

  it('only ever names real questions', () => {
    const keys = new Set(SCREENS.flatMap((s) => s.questions).map((q) => q.key));
    for (const key of CARRY_OVER_KEYS) expect(keys.has(key), key).toBe(true);
  });

  it('does not change the document a brief renders as', () => {
    // carriesOver is a flag on the question; renderBriefText must not have
    // learned about it. This is the same contract briefParts pins.
    const before = renderBriefText(FULL);
    expect(before).toContain('Care home owners and group directors.');
    expect(before).toContain('Book a demonstration.');
    expect(renderBriefText(FULL)).toBe(before);
  });
});
