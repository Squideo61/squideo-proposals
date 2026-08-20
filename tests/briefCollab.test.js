// The collaborative brief's two silent failure modes, pinned.
//
//  1. The diff. If it reports a change that didn't happen, every autosave rings
//     the bell for the whole team — the autosave posts a screen at a time, so a
//     naive "keys in the patch" diff fires on tabbing past an untouched field.
//  2. The digest. If a batch is described wrongly, or the "don't tell people
//     about their own typing" rule slips, the email becomes the thing everyone
//     filters — and it carries finalisation, which they can't afford to miss.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock, batchWrite: async () => {} };
});

import { diffAnswers, summariseAnswer, describeEvent, serialiseEvent } from '../api/_lib/brief/collab.js';
import { buildDigest, joinNames } from '../api/_lib/brief/digest.js';

describe('diffAnswers', () => {
  it('reports only what actually moved', () => {
    const before = { projectName: 'CareConnect', goal: 'onboard', audience: 'Care homes' };
    const patch = { projectName: 'CareConnect', goal: 'sell', audience: 'Care homes' };
    const out = diffAnswers(before, patch);
    expect(out.map((c) => c.questionKey)).toEqual(['goal']);
    expect(out[0].eventKey).toBe('answer.changed');
    expect(out[0].firstAnswer).toBe(false);
  });

  it('is quiet when a whole screen is posted back unchanged', () => {
    const answers = { projectName: 'CareConnect', goal: 'onboard', placements: ['homepage'] };
    expect(diffAnswers(answers, { ...answers })).toEqual([]);
  });

  it('compares arrays by value, not by identity', () => {
    const before = { placements: ['homepage', 'sales'] };
    expect(diffAnswers(before, { placements: ['homepage', 'sales'] })).toEqual([]);
    expect(diffAnswers(before, { placements: ['homepage'] })).toHaveLength(1);
  });

  it('separates a first answer from an edit, because the feed words them differently', () => {
    const out = diffAnswers({ goal: '' }, { goal: 'sell' });
    expect(out[0].firstAnswer).toBe(true);
    expect(describeEvent({ ...out[0], actorName: 'Priya' })).toContain('answered');
    const edit = diffAnswers({ goal: 'sell' }, { goal: 'onboard' });
    expect(describeEvent({ ...edit[0], actorName: 'Priya' })).toContain('updated');
  });

  it('treats emptying a field as a clear, not a change', () => {
    const out = diffAnswers({ audience: 'Care homes' }, { audience: '   ' });
    expect(out[0].eventKey).toBe('answer.cleared');
  });

  it('keeps the previous value so an accidental overwrite is recoverable', () => {
    const out = diffAnswers({ audience: 'Care homes' }, { audience: 'Pharmacies' });
    expect(out[0].before).toBe('Care homes');
    expect(out[0].after).toBe('Pharmacies');
  });
});

describe('summariseAnswer', () => {
  it('resolves a chip slug to the label a person would recognise', () => {
    expect(summariseAnswer('goal', 'onboard')).toBe('Onboarding or training');
  });

  it('truncates prose rather than putting 400 words in a feed row', () => {
    const long = 'x'.repeat(400);
    const out = summariseAnswer('audience', long);
    expect(out.length).toBeLessThanOrEqual(90);
    expect(out.endsWith('…')).toBe(true);
  });

  it('counts script rows instead of dumping them', () => {
    const rows = [{ script: 'Line one', visual: 'Logo' }, { script: 'Line two', visual: '' }, { script: '', visual: '' }];
    expect(summariseAnswer('script', rows)).toBe('2 rows');
  });

  it('says nothing about an empty answer', () => {
    expect(summariseAnswer('audience', '  ')).toBeNull();
  });
});

describe('serialiseEvent', () => {
  // The previous value stays server-side: every superseded draft of every
  // answer, fanned out to every colleague, is noise nobody asked for.
  it('never ships the previous value to the browser', () => {
    const out = serialiseEvent({
      id: 'e1', portal_user_id: 'pu1', actor_name: 'Priya', event_key: 'answer.changed',
      question_key: 'goal', question_label: 'What is this video for?',
      before_value: 'A secret earlier draft', after_value: 'sell', created_at: new Date().toISOString(),
    });
    expect(JSON.stringify(out)).not.toContain('secret earlier draft');
    expect(out.summary).toBe('Winning new customers');
    expect(out.text).toBe('Priya updated “What is this video for?”');
  });

  it('names Squideo when staff did it', () => {
    const out = serialiseEvent({
      id: 'e2', portal_user_id: null, staff_email: 'adam@squideo.co.uk', actor_name: null,
      event_key: 'brief.reopened', created_at: new Date().toISOString(),
    });
    expect(out.text).toBe('Squideo reopened the brief for editing');
  });
});

describe('digest wording', () => {
  it('names up to two people, then counts the rest', () => {
    expect(joinNames(['Priya'])).toBe('Priya');
    expect(joinNames(['Priya', 'Tom'])).toBe('Priya and Tom');
    expect(joinNames(['Priya', 'Tom', 'Sam', 'Jo'])).toBe('Priya, Tom and 2 others');
    // The same person editing ten questions is still one name.
    expect(joinNames(['Priya', 'Priya', 'Priya'])).toBe('Priya');
  });

  it('leads with the finalisation when there is one', () => {
    const events = [
      { actorName: 'Priya', eventKey: 'answer.changed', text: 'Priya updated “Goal”', summary: 'Sell' },
      { actorName: 'Priya', eventKey: 'brief.finalised', text: 'Priya finalised the brief', summary: null },
    ];
    const { subject, inner } = buildDigest({ briefTitle: 'CareConnect', events, url: 'https://x/#/brief/1' });
    expect(subject).toBe('Priya finalised CareConnect');
    expect(inner).toContain('locked');
  });

  it('counts the changes otherwise', () => {
    const events = Array.from({ length: 14 }, (_, i) => ({
      actorName: i % 2 ? 'Tom' : 'Priya', eventKey: 'answer.changed',
      text: `change ${i}`, summary: null,
    }));
    const { subject, inner } = buildDigest({ briefTitle: 'CareConnect', events, url: 'https://x' });
    expect(subject).toBe('Priya and Tom made 14 changes to CareConnect');
    // Capped, with the remainder acknowledged rather than silently dropped.
    expect(inner).toContain('and 2 more');
  });

  it('escapes what the client typed', () => {
    const events = [{
      actorName: '<script>alert(1)</script>', eventKey: 'answer.changed',
      text: 'x updated “Goal”', summary: '<img onerror=1>',
    }];
    const { inner } = buildDigest({ briefTitle: 'A & B', events, url: 'https://x' });
    expect(inner).not.toContain('<script>');
    expect(inner).not.toContain('<img onerror');
    expect(inner).toContain('&amp;');
  });
});
