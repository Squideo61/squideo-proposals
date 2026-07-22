import { describe, it, expect } from 'vitest';
import { applyInclusionTokens, SCRIPT_WORDS_PER_MINUTE } from '../src/defaults.js';

// The script allowance is quoted per minute of content, so an inclusion stating a
// word count grows with the proposal's length. Proposals store their own copy of
// baseInclusions, so this has to work on text written before the feature existed —
// hence rescaling the literal phrasing rather than relying on a token.

describe('applyInclusionTokens', () => {
  const DEFAULT_LINE = 'Utilisation of up to 140 words of your provided script narrative';

  it('leaves the standard inclusion alone on a one-minute proposal', () => {
    expect(applyInclusionTokens(DEFAULT_LINE, 1)).toBe(DEFAULT_LINE);
  });

  it('scales the written figure as a per-minute allowance', () => {
    expect(applyInclusionTokens(DEFAULT_LINE, 8))
      .toBe('Utilisation of up to 1,120 words of your provided script narrative');
  });

  it('treats a missing or zero minute count as a single minute', () => {
    expect(applyInclusionTokens(DEFAULT_LINE, 0)).toBe(DEFAULT_LINE);
    expect(applyInclusionTokens(DEFAULT_LINE, undefined)).toBe(DEFAULT_LINE);
  });

  it('honours a custom per-minute allowance, not just the default 140', () => {
    expect(applyInclusionTokens('up to 200 words', 3)).toBe('up to 600 words');
  });

  it('handles an already-formatted figure with a thousands separator', () => {
    expect(applyInclusionTokens('up to 1,000 words', 2)).toBe('up to 2,000 words');
  });

  it('substitutes the {words} and {minutes} tokens', () => {
    expect(applyInclusionTokens('{words} words across {minutes} minutes', 4))
      .toBe(`${(SCRIPT_WORDS_PER_MINUTE * 4).toLocaleString('en-GB')} words across 4 minutes`);
  });

  // Guards against the rescale being too eager on neighbouring copy.
  it('does not touch a words-per-minute rate elsewhere in the inclusions', () => {
    const line = 'Delivered at an optimum rate of 140wpm.';
    expect(applyInclusionTokens(line, 8)).toBe(line);
  });

  it('does not touch a word count that is not phrased as an allowance', () => {
    const line = 'Your script came to 140 words in total.';
    expect(applyInclusionTokens(line, 8)).toBe(line);
  });

  it('passes empty values straight through', () => {
    expect(applyInclusionTokens('', 8)).toBe('');
    expect(applyInclusionTokens(undefined, 8)).toBe(undefined);
  });
});
