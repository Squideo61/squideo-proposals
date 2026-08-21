// The brief, printed. This used to be window.print() on the portal page, which
// printed the portal — nav rail, activity feed and all. It is now a built
// document (src/utils/printBrief.js), and the things that would quietly ruin it
// are all invisible until a client has already sent it to their MD:
//
//  · an unanswered question printing an empty row, which reads as a fault
//  · a slug printing where a label should be — "5-10k" instead of the band
//  · a draft that doesn't say it is a draft, and gets quoted against
//  · an apostrophe in a company name breaking the markup
import { describe, it, expect } from 'vitest';
import { buildBriefHTML } from '../src/utils/printBrief.js';

const FULL = {
  projectName: 'Northwind Ordering launch film',
  goal: 'onboard',
  oneAction: 'Contact their account manager to book a demonstration.',
  audience: 'Care home owners and group directors.',
  placements: ['homepage', 'sales'],
  budget: '5-10k',
  volume: 'one',
  deadline: 'Mid-October',
  scriptRows: [
    { script: 'Every care home runs on a hundred small orders a week.', visual: 'Boxes at a back door.' },
    { script: '', visual: '' },
  ],
};

const doc = (over = {}) => buildBriefHTML({
  answers: FULL,
  brief: { title: 'Northwind Ordering launch film', locked: true },
  company: { name: 'Northwind Care Group' },
  progress: { done: 8, total: 22 },
  ...over,
});

describe('the printed brief', () => {
  it('prints answers, and only answers', () => {
    const html = doc();
    expect(html).toContain('Contact their account manager');
    // Every question in the brief that was NOT answered must be absent — a
    // labelled empty row is the thing that makes a document look broken.
    expect(html).not.toContain('Any videos you like the look of?');
    expect(html).not.toContain('Who needs to approve this?');
  });

  it('prints the human label for a chip answer, never the stored slug', () => {
    const html = doc();
    // parseBudgetLower() has already been bitten by a raw "5-10k" once — see
    // answerLabel in questions.js. A document showing one is the same bug.
    expect(html).not.toContain('5-10k');
    expect(html).toContain('£5,000 – £10,000 ex VAT');
    expect(html).toContain('Onboarding or training');
  });

  it('numbers the sections it actually printed', () => {
    // Nothing from "Look and feel" is answered, so it must not appear at all,
    // and the sections after it must not skip a number.
    const html = doc();
    expect(html).not.toContain('Look and feel');
    const discs = [...html.matchAll(/<span class="disc">(\d+)<\/span>/g)].map((m) => m[1]);
    expect(discs).toEqual(['1', '2', '3', '4']);
  });

  it('does not print the one-line answer twice', () => {
    // It is the hero panel at the top. Printing it again in its section a page
    // later reads as a mistake rather than as emphasis.
    const html = doc();
    const hits = html.split('Contact their account manager').length - 1;
    expect(hits).toBe(1);
  });

  it('drops blank script rows and numbers what is left', () => {
    const html = doc();
    expect(html).toContain('Every care home runs on a hundred small orders');
    expect([...html.matchAll(/<span class="disc sm">(\d+)<\/span>/g)].map((m) => m[1])).toEqual(['1']);
  });

  it('says out loud when it is a draft, and what is missing', () => {
    const html = doc({ brief: { title: 'Half a brief', locked: false } });
    expect(html).toContain('Draft');
    expect(html).toContain('Still to answer');
    // The required questions with no answer, by name.
    expect(html).toContain('Describe the person you want watching this');
    expect(html).toContain('working draft');
    expect(html).not.toContain('This is the final version');
  });

  it('says out loud when it is final, and who finalised it', () => {
    const html = doc({ brief: { title: 'Done', locked: true, submittedBy: 'Alex Morgan' } });
    expect(html).toContain('This is the final version');
    expect(html).toContain('Alex Morgan');
    expect(html).not.toContain('Still to answer');
  });

  it('escapes what the client typed', () => {
    const html = buildBriefHTML({
      answers: { projectName: '<script>alert(1)</script>', audience: 'Tom & Jerry "Ltd"' },
      brief: { title: '<script>alert(1)</script>', locked: false },
      company: { name: "O'Neill & Sons <b>" },
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Tom &amp; Jerry &quot;Ltd&quot;');
    expect(html).toContain('&lt;b&gt;');
  });

  it('fills in the length it can infer, and marks it as ours', () => {
    // Length falls out of where the video will be seen. Presenting our guess as
    // the client's answer is how a producer ends up building to a number nobody
    // agreed — so the facts panel labels it, and the body never claims it.
    const html = doc();
    expect(html).toContain('suggested');
    expect(html).toContain('60–90 seconds');
    expect(html).not.toContain('How long should it be?');
  });

  it('survives an empty brief without throwing', () => {
    const html = buildBriefHTML();
    expect(html).toContain('Nothing has been answered yet');
    expect(html).toContain('Video brief');
  });
});
